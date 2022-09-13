"use strict";

const Common = require('./common.js');
var logger = Common.getLogger(__filename);
const crypto = require('crypto');


const defaultLockTimeout = 2 * 60 * 1000; //2 minutes
const defualtNumOfRetries = 100;
const defualtWaitInterval = 50;

/**
 * Lock in memoery implments with await async
 */
 class Lock {


    static locks = {};

    /**
     * Initiate the lock object
     * @param {*} key
     * @param {*} parameters
     */
    constructor(key,options) {
        this._key = key;
        if (!this._key) {
            throw new Error("Lock. invalid key");
        }
        const parameters = options || {};
        this._numOfRetries = (parameters.numOfRetries ? parameters.numOfRetries : defualtNumOfRetries);
        this._waitInterval = (parameters.waitInterval ? parameters.waitInterval : defualtWaitInterval);
        this._lockTimeout = (parameters.lockTimeout ? parameters.lockTimeout : defaultLockTimeout);
        this._token = crypto.randomBytes(32).toString('hex');
        this._lockTimeoutFunc = null;
        this._lockAquired = false;
        this._acquireCnt = 0;

    }

    /**
     * Aquire the lock. thow error in case cannot aquire the lock
     * @returns
     */
    async acquire() {
        let self = this;
        let iter = 0;
        // console.log(`Aquire lock: ${this._key}`);
        while (!self._lockAquired && iter <= self._numOfRetries) {
            if (!Lock.locks[self._key]) {
                Lock.locks[self._key] = self;
                self._lockAquired = true;
                self._lockTime = new Date();
                break;
            }
            await sleep(self._waitInterval);
            ++iter;
        }
        if (!self._lockAquired) {
            var errMsg = `Lock.acquire: couldn't acquire lock on ${self._key}, numOfRetries: ${self._numOfRetries}, waitInterval: ${self._waitInterval}`;
            logger.info(errMsg);
            throw new Error(errMsg);
        }
        self._acquireCnt++;
        if (!self._lockTimeoutFunc) {
            self._lockTimeoutFunc = setTimeout(
            (function() {
                logger.error("acquire: execution of critical section for lock on \'" + self._key + "\' take too much time.");
                try {
                    self.release();
                } catch (err) {
                    logger.error(`Lock._lockTimeoutFunc release error: ${err}`,err);
                }
            }), self._lockTimeout);
        }
        // console.log(`Aquired! lock: ${this._key}, acquireCnt: ${self._acquireCnt}`);
        return true;
    }

    /**
     * Release the lock. throw error in case lock not found
     */
    release() {
        if (!this._lockAquired) {
            logger.info("Lock.release: lock on \'" + this._key + "\' wasn't aquired before");
            return;
        }
        this._acquireCnt--;
        if (this._acquireCnt>0) {
            return; // no need to release just decrease counter;
        }
        let currentLock = Lock.locks[this._key];
        if (!currentLock) {
            throw new Error(`Lock.release. current lock with key ${this._key}) not found!`);
        }
        if (this._token != currentLock._token) {
            throw new Error(`Lock.release. current token (${currentLock._token}) differ from acquired token (${this._token})`);
        }
        // delete current lock
        delete Lock.locks[this._key];
        this._lockAquired = false;
        clearTimeout(this._lockTimeoutFunc);
        // console.log(`Released. lock: ${this._key}`);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


module.exports = Lock;