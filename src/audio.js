"use strict";
var Common = require('./common.js');
var logger = Common.getLogger(__filename);
var async = require('async');
var execFile = require('child_process').execFile;
var spawn = require('child_process').spawn;
var ps = require('ps-node');
var fs = require('fs');



/**
 * Initialize pulse audio for sending audio stream
 */

function initAudio(localid, callback) {
    async.series([
        (cb) => {
            var child = spawn("node",["dist/audiomanager.js", localid]);
            logger.info("Starting ","node",["audiomanager.js", localid]);
            var userid = localid;
            child.stdout.on('data', (data) => {
                logger.info(`audiomanager.js userid: ${userid}, stdout: ${data}`);
            });

            child.stderr.on('data', (data) => {
                logger.info(`audiomanager.js userid: ${userid}, stderr: ${data}`);
            });

            child.on('close', (code) => {
                logger.info(`audiomanager.js userid: ${userid}, child process exited with code ${code}`);
            });
            cb();
        }
    ], function (err) {
        if (err) {
            logger.error("initAudio: " + err);
        }
        callback(err);
    });

}

/**
 * Deinitialize pulse audio for user
 */

function deInitAudio(localid, callback) {
    async.series([
        // kill the audio manager process
        function(callback) {
            var cmd = "node";
            var arg1 =  "dist/audiomanager.js";
            var arg2 =  localid;
            ps.lookup({
                command: cmd//,
                //arguments: "audiomanager.js",
            }, function(err, resultList) {
                if (err) {
                    logger.error("Unable to kill audiomanager.js, ps error: ", err);
                    callback(null);
                    return;
                }
                var processFound = false;
                resultList.forEach(function(process) {
                    if (process) {
                        logger.info(`PID: ${process.pid}, COMMAND: ${process.command}, ARGUMENTS: ${process.arguments}`);
                        var matchUser = (process.arguments.indexOf(arg1) > -1 && process.arguments.indexOf(arg2) > -1) ;
                        if (matchUser) {
                            processFound = true;
                            ps.kill(process.pid, 'SIGINT', function(err) {
                                if (err) {
                                    logger.error("Unable to kill audiomanager.js, kill error: ", err);
                                } else {
                                    logger.info('audiomanager.js has been killed.');
                                }
                                return;
                            });
                        }
                    }
                });
                if (!processFound) {
                    logger.info('"Unable to kill audiomanager.js, process not found.');
                }
                callback(null);
            });
        }
    ], function (err) {
        if (err) {
            logger.error("deInitAudio: " + err);
        }
        callback(err);
    });

}

module.exports = {
    initAudio: initAudio,
    deInitAudio: deInitAudio

};
