"use strict";

var fs = require('fs');
var Common = require('./common.js');
var localPlatform = null;

var Platform = function(curLogger) {
    var logger = curLogger;
    var ssh = null;
    var init = function(callback) {
        if(ssh === null) {
            require('./ssh')(
                {
                    username: "root",
                    host: "127.0.0.1",
                    port: 2222,
                    privateKey: fs.readFileSync(Common.sshPrivateKey)
                },
                {},
                function(err, sshobj) {
                    if(err) {
                        logger.error("Cannot init platform ssh connection, err:" + err);
                    } else {
                        ssh = sshobj;
                    }
                    callback(err);
                }
            );
        } else {
            callback(null);
        }
    };

    this.exec = function(cmd, callback) {
        this.execWithTimeout(cmd, 60 * 1000, logger, callback);
    };

    this.execWithTimeout = function(cmd, timeout, logger, callback) {
        //logger.info("Platform.js - exec cmd:" + cmd);
        (function(self) {
            if(ssh === null) {
                init(function(err) {
                    if(err) {
                        logger.error("exec request init. Error happen on init state, err:" + err);
                        callback(err);
                    } else {
                        ssh.execWithTimeout(cmd, timeout, logger, callback);
                    }
                });
            } else {
                ssh.execWithTimeout(cmd, timeout, logger, callback);
            }
        })(this);
    };

    this.end = function() {
        ssh.end();
    };
    return this;
};

if (module) {
    module.exports = Platform;
}
