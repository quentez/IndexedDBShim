import {createEvent} from './Event.js';
import {logError, findError, webSQLErrback, createDOMException} from './DOMException.js';
import {IDBRequest} from './IDBRequest.js';
import * as util from './util.js';
import IDBObjectStore from './IDBObjectStore.js';
import CFG from './CFG.js';
import EventTarget from 'eventtarget';
import SyncPromise from 'sync-promise';

let uniqueID = 0;

/**
 * The IndexedDB Transaction
 * http://dvcs.w3.org/hg/IndexedDB/raw-file/tip/Overview.html#idl-def-IDBTransaction
 * @param {IDBDatabase} db
 * @param {string[]} storeNames
 * @param {string} mode
 * @constructor
 */
function IDBTransaction (db, storeNames, mode) {
    const me = this;
    me.__id = ++uniqueID; // for debugging simultaneous transactions
    me.__active = true;
    me.__running = false;
    me.__errored = false;
    me.__requests = [];
    me.__objectStoreNames = storeNames;
    me.__mode = mode;
    me.__db = db;
    me.__error = null;
    me.__internal = false;
    me.onabort = me.onerror = me.oncomplete = null;
    me.__storeClones = {};
    me.__setOptions({defaultSync: true, extraProperties: ['complete']}); // Ensure EventTarget preserves our properties

    // Kick off the transaction as soon as all synchronous code is done
    setTimeout(() => { me.__executeRequests(); }, 0);
}

IDBTransaction.prototype.__transFinishedCb = function (err, cb) {
    if (err) {
        cb(true);
        return;
    }
    cb();
};

IDBTransaction.prototype.__executeRequests = function () {
    const me = this;
    if (me.__running) {
        CFG.DEBUG && console.log('Looks like the request set is already running', me.mode);
        return;
    }

    me.__running = true;

    me.db.__db[me.mode === 'readonly' ? 'readTransaction' : 'transaction']( // `readTransaction` is optimized, at least in `node-websql`
        function executeRequests (tx) {
            me.__tx = tx;
            let q = null, i = -1;

            function success (result, req) {
                if (me.__errored || me.__requestsFinished) {
                    // We've already called "onerror", "onabort", or thrown within the transaction, so don't do it again.
                    return;
                }
                if (req) {
                    q.req = req; // Need to do this in case of cursors
                }
                if (q.req.__readyState === 'done') { // Avoid continuing with aborted requests
                    return;
                }
                q.req.__readyState = 'done';
                q.req.__result = result;
                q.req.__error = null;
                const e = createEvent('success');
                try { // Catching a `dispatchEvent` call is normally not possible for a standard `EventTarget`,
                    // but we are using the `EventTarget` library's `__userErrorEventHandler` to override this
                    // behavior for convenience in our internal calls
                    me.__internal = true;
                    me.__active = true;
                    q.req.dispatchEvent(e);
                    me.__internal = false;
                    // Do not set __active flag to false yet: https://github.com/w3c/IndexedDB/issues/87
                } catch (err) {
                    me.__internal = false;
                    me.__abortTransaction(createDOMException('AbortError', 'A request was aborted.'));
                    return;
                }
                executeNextRequest();
            }

            function error (...args /* tx, err */) {
                if (me.__errored || me.__requestsFinished) {
                    // We've already called "onerror", "onabort", or thrown within the transaction, so don't do it again.
                    return;
                }
                if (q.req && q.req.__readyState === 'done') { // Avoid continuing with aborted requests
                    return;
                }
                const err = findError(args);
                if (!q.req) {
                    me.__abortTransaction(err);
                    return;
                }
                // Fire an error event for the current IDBRequest
                q.req.__readyState = 'done';
                q.req.__error = err;
                q.req.__result = undefined;
                q.req.addLateEventListener('error', function (e) {
                    if (e.cancelable && e.defaultPrevented) {
                        executeNextRequest();
                    }
                });
                q.req.addDefaultEventListener('error', function () {
                    me.__abortTransaction(q.req.__error);
                });
                let e;
                try { // Catching a `dispatchEvent` call is normally not possible for a standard `EventTarget`,
                    // but we are using the `EventTarget` library's `__userErrorEventHandler` to override this
                    // behavior for convenience in our internal calls
                    me.__internal = true;
                    me.__active = true;
                    e = createEvent('error', err, {bubbles: true, cancelable: true});
                    q.req.dispatchEvent(e);
                    me.__internal = false;
                    // Do not set __active flag to false yet: https://github.com/w3c/IndexedDB/issues/87
                } catch (handlerErr) {
                    me.__internal = false;
                    logError('Error', 'An error occurred in a handler attached to request chain', handlerErr); // We do nothing else with this `handlerErr` per spec
                    e.preventDefault(); // Prevent 'error' default as steps indicate we should abort with `AbortError` even without cancellation
                    me.__abortTransaction(createDOMException('AbortError', 'A request was aborted.'));
                }
            }

            function executeNextRequest () {
                if (me.__errored || me.__requestsFinished) {
                    // We've already called "onerror", "onabort", or thrown within the transaction, so don't do it again.
                    return;
                }
                i++;
                if (i >= me.__requests.length) {
                    // All requests in the transaction are done
                    me.__requests = [];
                    if (me.__active) {
                        requestsFinished();
                    }
                } else {
                    try {
                        q = me.__requests[i];
                        if (!q.req) {
                            q.op(tx, q.args, executeNextRequest, error);
                            return;
                        }
                        if (q.req.__readyState === 'done') { // Avoid continuing with aborted requests
                            return;
                        }
                        q.op(tx, q.args, success, error, executeNextRequest);
                    } catch (e) {
                        error(e);
                    }
                }
            }

            executeNextRequest();
        },
        function webSQLError (webSQLErr) {
            if (webSQLErr === true) { // Not a genuine SQL error
                return;
            }
            const err = webSQLErrback(webSQLErr);
            me.__abortTransaction(err);
        },
        function () {
            // For Node, we don't need to try running here as we can keep
            //   the transaction running long enough to rollback (in the
            //   next (non-standard) callback for this transaction call)
            if (me.__transFinishedCb !== IDBTransaction.prototype.__transFinishedCb) { // Node
                return;
            }
            if (!me.__transactionEndCallback && !me.__requestsFinished) {
                me.__transactionFinished = true;
                return;
            }
            if (me.__transactionEndCallback && !me.__completed) {
                me.__transFinishedCb(me.__errored, me.__transactionEndCallback);
            }
        },
        function (currentTask, err, done, rollback, commit) {
            if (currentTask.readOnly || err) {
                return true;
            }
            me.__transFinishedCb = function (err, cb) {
                if (err) {
                    rollback(err, cb);
                } else {
                    commit(cb);
                }
            };
            if (me.__transactionEndCallback && !me.__completed) {
                me.__transFinishedCb(me.__errored, me.__transactionEndCallback);
            }
            return false;
        }
    );

    function requestsFinished () {
        me.__active = false;
        me.__requestsFinished = true;
        function complete () {
            me.__completed = true;
            CFG.DEBUG && console.log('Transaction completed');
            const evt = createEvent('complete');
            try {
                me.__internal = true;
                me.dispatchEvent(evt);
                me.__internal = false;
                me.dispatchEvent(createEvent('__complete'));
            } catch (e) {
                me.__internal = false;
                // An error occurred in the "oncomplete" handler.
                // It's too late to call "onerror" or "onabort". Throw a global error instead.
                // (this may seem odd/bad, but it's how all native IndexedDB implementations work)
                me.__errored = true;
                throw e;
            } finally {
                me.__storeClones = {};
            }
        }
        if (me.mode === 'readwrite') {
            if (me.__transactionFinished) {
                complete();
                return;
            }
            me.__transactionEndCallback = complete;
            return;
        }
        if (me.mode === 'readonly') {
            complete();
            return;
        }
        try { // Catching a `dispatchEvent` call is normally not possible for a standard `EventTarget`,
            // but we are using the `EventTarget` library's `__userErrorEventHandler` to override this
            // behavior for convenience in our internal calls
            me.__internal = true;
            const ev = createEvent('__beforecomplete');
            ev.complete = complete;
            me.dispatchEvent(ev);
        } catch (err) {
        } finally {
            me.__internal = false;
        }
    }
};

/**
 * Creates a new IDBRequest for the transaction.
 * NOTE: The transaction is not queued until you call {@link IDBTransaction#__pushToQueue}
 * @returns {IDBRequest}
 * @protected
 */
IDBTransaction.prototype.__createRequest = function (source) {
    const me = this;
    const request = new IDBRequest();
    request.__source = source !== undefined ? source : me.db;
    request.__transaction = me;
    return request;
};

/**
 * Adds a callback function to the transaction queue
 * @param {function} callback
 * @param {*} args
 * @returns {IDBRequest}
 * @protected
 */
IDBTransaction.prototype.__addToTransactionQueue = function (callback, args, source) {
    const request = this.__createRequest(source);
    this.__pushToQueue(request, callback, args);
    return request;
};

/**
 * Adds a callback function to the transaction queue without generating a request
 * @param {function} callback
 * @param {*} args
 * @returns {IDBRequest}
 * @protected
 */
IDBTransaction.prototype.__addNonRequestToTransactionQueue = function (callback, args, source) {
    this.__pushToQueue(null, callback, args);
};

/**
 * Adds an IDBRequest to the transaction queue
 * @param {IDBRequest} request
 * @param {function} callback
 * @param {*} args
 * @protected
 */
IDBTransaction.prototype.__pushToQueue = function (request, callback, args) {
    this.__assertActive();
    this.__requests.push({
        'op': callback,
        'args': args,
        'req': request
    });
};

IDBTransaction.prototype.__assertActive = function () {
    if (!this.__active) {
        throw createDOMException('TransactionInactiveError', 'A request was placed against a transaction which is currently not active, or which is finished');
    }
};

IDBTransaction.prototype.__assertWritable = function () {
    if (this.mode === 'readonly') {
        throw createDOMException('ReadOnlyError', 'The transaction is read only');
    }
};

IDBTransaction.prototype.__assertVersionChange = function () {
    IDBTransaction.__assertVersionChange(this);
};

/**
 * Returns the specified object store.
 * @param {string} objectStoreName
 * @returns {IDBObjectStore}
 */
IDBTransaction.prototype.objectStore = function (objectStoreName) {
    const me = this;
    if (arguments.length === 0) {
        throw new TypeError('No object store name was specified');
    }
    if (!me.__active) {
        throw createDOMException('InvalidStateError', 'A request was placed against a transaction which is currently not active, or which is finished');
    }
    if (me.__objectStoreNames.indexOf(objectStoreName) === -1) {
        throw createDOMException('NotFoundError', objectStoreName + ' is not participating in this transaction');
    }
    const store = me.db.__objectStores[objectStoreName];
    if (!store) {
        throw createDOMException('NotFoundError', objectStoreName + ' does not exist in ' + me.db.name);
    }

    if (!me.__storeClones[objectStoreName] ||
        me.__storeClones[objectStoreName].__deleted) { // The latter condition is to allow store
                                                         //   recreation to create new clone object
        me.__storeClones[objectStoreName] = IDBObjectStore.__clone(store, me);
    }
    return me.__storeClones[objectStoreName];
};

IDBTransaction.prototype.__abortTransaction = function (err) {
    const me = this;
    logError('Error', 'An error occurred in a transaction', err);
    if (me.__errored) {
        // We've already called "onerror", "onabort", or thrown, so don't do it again.
        return;
    }
    me.__errored = true;

    if (me.mode === 'versionchange') { // Steps for aborting an upgrade transaction
        me.db.__version = me.db.__oldVersion;
        me.db.__objectStoreNames = me.db.__oldObjectStoreNames;
        Object.keys(me.__storeClones).forEach(function (objectStoreName) {
            const store = me.__storeClones[objectStoreName];
            store.__name = store.__originalName;
            store.__indexNames = store.__oldIndexNames;
            Object.keys(store.__indexes).forEach(function (indexName) {
                const index = store.__indexes[indexName];
                index.__name = index.__originalName;
            });
        });
    }
    me.__active = false; // Setting here and in requestsFinished for https://github.com/w3c/IndexedDB/issues/87

    if (err !== null) {
        me.__error = err;
    }

    if (me.__requestsFinished) {
        // The transaction has already completed, so we can't call "onerror" or "onabort".
        // So throw the error instead.
        setTimeout(() => {
            throw err;
        }, 0);
    }

    function abort (tx, errOrResult) {
        if (!tx) {
            CFG.DEBUG && console.log('Rollback not possible due to missing transaction', me);
        } else if (errOrResult && typeof errOrResult.code === 'number') {
            CFG.DEBUG && console.log('Rollback erred; feature is probably not supported as per WebSQL', me);
        } else {
            CFG.DEBUG && console.log('Rollback succeeded', me);
        }

        me.__requests.filter(function (q) {
            return q.req && q.req.__readyState !== 'done';
        }).reduce(function (promises, q) {
            // We reduce to a chain of promises to be queued in order, so we cannot use `Promise.all`,
            //  and I'm unsure whether `setTimeout` currently behaves first-in-first-out with the same timeout
            //  so we could just use a `forEach`.
            return promises.then(function () {
                q.req.__readyState = 'done';
                q.req.__result = undefined;
                q.req.__error = createDOMException('AbortError', 'A request was aborted.');
                const reqEvt = createEvent('error', q.req.__error, {bubbles: true, cancelable: true});
                return new SyncPromise(function (resolve) {
                    setTimeout(() => {
                        q.req.dispatchEvent(reqEvt); // No need to catch errors
                        resolve();
                    });
                });
            });
        }, SyncPromise.resolve()).then(function () { // Also works when there are no pending requests
            const evt = createEvent('abort', err, {bubbles: true, cancelable: false});
            me.dispatchEvent(evt);
            me.__storeClones = {};
            me.dispatchEvent(createEvent('__abort'));
        });
    }

    me.__transFinishedCb(true, function (rollback) {
        if (rollback && me.__tx) { // Not supported in standard SQL (and WebSQL errors should
            //   rollback automatically), but for Node.js, etc., we give chance for
            //   manual aborts which would otherwise not work.
            if (me.mode === 'readwrite') {
                if (me.__transactionFinished) {
                    abort();
                    return;
                }
                me.__transactionEndCallback = abort;
                return;
            }
            me.__tx.executeSql('ROLLBACK', [], abort, abort); // Not working in some circumstances, even in Node
        } else {
            abort(null, {code: 0});
        }
    });
};

IDBTransaction.prototype.abort = function () {
    const me = this;
    CFG.DEBUG && console.log('The transaction was aborted', me);
    if (!me.__active) {
        throw createDOMException('InvalidStateError', 'A request was placed against a transaction which is currently not active, or which is finished');
    }
    me.__abortTransaction(null);
};
IDBTransaction.prototype.toString = function () {
    return '[object IDBTransaction]';
};

IDBTransaction.__assertVersionChange = function (tx) {
    if (!tx || tx.mode !== 'versionchange') {
        throw createDOMException('InvalidStateError', 'Not a version transaction');
    }
};
IDBTransaction.__assertNotVersionChange = function (tx) {
    if (tx && tx.mode === 'versionchange') {
        throw createDOMException('InvalidStateError', 'Cannot be called during a version transaction');
    }
};

IDBTransaction.__assertActive = function (tx) {
    if (!tx || !tx.__active) {
        throw createDOMException('TransactionInactiveError', 'A request was placed against a transaction which is currently not active, or which is finished');
    }
};

/**
* Used by our EventTarget.prototype library to implement bubbling/capturing
*/
IDBTransaction.prototype.__getParent = function () {
    return this.db;
};
/**
* Used by our EventTarget.prototype library to detect errors in user handlers
*/
IDBTransaction.prototype.__userErrorEventHandler = function (error, triggerGlobalErrorEvent) {
    if (this.__internal) {
        this.__internal = false;
        throw error;
    }
    triggerGlobalErrorEvent();
};

util.defineReadonlyProperties(IDBTransaction.prototype, ['objectStoreNames', 'mode', 'db', 'error']);

Object.assign(IDBTransaction.prototype, EventTarget.prototype);

export default IDBTransaction;
