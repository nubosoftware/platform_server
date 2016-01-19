"use strict";

/**
 *	simplessh.js
 *  Simple class for ssh client to the nubo host
 */
var Common = require('./common.js');
var Client = require('ssh2').Client;
var sshPool = [];

var CreateConnection = function (opts, extras, callback) {
    if (!opts.privateKey) opts.privateKey = require('fs').readFileSync(Common.sshPrivateKey);

    this.logger = ((extras && extras.logger) ? extras.logger : Common.logger);
    this.isReady = false;
    this.connection = new Client();
    this.connError = false;
    this.stack = new Error().stack;
    this.poolLine = opts.username + "@" + opts.host + ':' + opts.port;

    (function (sshobj) {
        sshobj.connection.on('ready', function() {
            sshobj.logger.info('Connection :: ready');
            if (!sshobj.isReady) {
                sshobj.isReady = true;
                sshPool[sshobj.poolLine] = sshobj;
                Common.logger.info("!!!!! NEW POOL: \n", Object.getOwnPropertyNames(sshPool));
                if (callback) callback(null,sshobj);
            }
        });
        sshobj.connection.on('error', function(err) {
            sshobj.logger.info('Connection :: error :: ' + err);
            sshobj.connError = true;
            delete sshPool[sshobj.poolLine];
            sshobj.connection.end();
            if (!sshobj.isReady) { // connection was not OK
                sshobj.isReady = true;
                if (callback) callback(err,sshobj);
            }
        });
        sshobj.connection.on('end', function() {
            sshobj.logger.info('Connection :: end ' + sshobj.poolLine);
            sshobj.connError = true;
            delete sshPool[sshobj.poolLine];
            if (!sshobj.isReady) { // connection was not OK
                sshobj.isReady = true;
                if (callback) callback("Connection ended before ready",sshobj);
            }
        });
        sshobj.connection.on('close', function(had_error) {
            sshobj.logger.info('Connection :: close ' + sshobj.poolLine);
            sshobj.connError = true;
            delete sshPool[sshobj.poolLine];
            if (!sshobj.isReady) { // connection was not OK
                sshobj.isReady = true;
                if (callback) callback("Connection closed before ready",sshobj);
            }
        });
        sshobj.logger.info("simpleSSH connect to " + opts.username + '@' + opts.host + ':' + opts.port);
        sshobj.connection.connect(opts);
    }) (this);

    this.exec = function (cmd, logger, callback) {
        this.execWithTimeout(cmd, 60*1000, logger, callback);
    };

    this.execWithTimeout = function (cmd,timeout, logger, callback) {
        //logger.info("ssh.js - execWithTimeout cmd:" + cmd);
        var execStack = new Error().stack;
        (function (sshobj) {
            var sshout = "";
            var ssherr = "";
            var done = false;
            var timeOutCmd = null;
            var streamCode,streamSignal;
            if(sshobj.connError) {
                logger.info('exec :: Connetion error');
                if (callback) callback('exec :: Connetion error');
                return;
            }
            sshobj.connection.exec(cmd, function(err, stream) {
                //logger.info("ssh.js - exec cmd:" + cmd);
                if (err) {
                    logger.info('exec :: err: ' + err);
                    if (callback) callback(err+", stack:"+execStack);
                    return;
                }
                if (timeout>0) {
                    timeOutCmd = setTimeout((function() {
                        logger.info('Stream :: timeout for cmd: '+cmd);
                        var msg = "Timeout"+", stack:"+execStack;
                        stream.emit('close');
                        if (!done) {
                            done = true;
                            callback(msg, -110, null, sshout);
                        }
                    }), timeout); // setTimeout
                }

                stream.on('data', function(data) {
                    //logger.info('simpleSSH STDOUT: ' + data);
                    sshout += data;
                }); // stream.on('data'
                stream.stderr.on('data', function(data) {
                    //logger.info('simpleSSH STDERR: ' + data);
                    ssherr += data;
                    sshout += data;
                }); // stream.on('data'
                stream.on('exit', function(code, signal) {
                    //logger.info('Stream :: exit :: sshout: '+sshout);
                    //logger.info('Stream :: exit :: ssherr: '+ssherr);
                    if (timeOutCmd) clearTimeout(timeOutCmd);
                    if (!done) {
                        done = true;
                        callback(null, code, signal, sshout);
                    }
                }); // stream.on('end'
            });
        }) (this);
    };

    this.end = function() {
        this.logger.info('NO END ' + (new Error().stack));
        this.connection.end();
    };
};

var assert = require('assert');
module.exports = function (opts, extras, callback) {
    Common.logger.info("!!!!! POOL: \n", Object.getOwnPropertyNames(sshPool));
    assert((typeof callback === 'function'), "Wrong usage in module permanentssh");
    if (!opts.port) opts.port = 22;
    if (!opts.keepaliveInterval) opts.keepaliveInterval = 15*1000;
    var logger = ((extras && extras.logger) ? extras.logger : Common.logger);
    var poolLine = opts.username + "@" + opts.host + ':' + opts.port;

    if (sshPool[poolLine]) {
        logger.info("OK... " + poolLine + " already in pool");
        if (callback) callback(null,sshPool[poolLine]);
    } else {
        logger.info("Wait... connecting to " + poolLine);
        new CreateConnection(opts, extras, callback);
    }
};