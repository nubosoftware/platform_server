"use strict";
var Common = require('./common.js');
var logger = Common.getLogger(__filename);
var async = require('async');
var execFile = require('child_process').execFile;
var spawn = require('child_process').spawn;
var ps = require('ps-node');
var fs = require('fs');
const path = require('path');



/**
 * Initialize pulse audio for sending audio stream
 */


function initAudio(localid) {
    return new Promise((resolve,reject) => {
        async.series([
            (cb) => {
                let pulse_opts = {
                    uid : 1000,
                    gid : 1000,
                    env: {
                        "PULSE_SERVER": "unix:/run/user/1000/pulse/native",
                        "PULSE_RUNTIME_PATH": "/run/user/1000/pulse"
                    }
                };
                if (Common.isDocker) {
                    pulse_opts.env = {
                        "HOME": "/home/nubo",
                    }
                }
                logger.info(`initAudio. localid: ${localid}, isDocker: ${Common.isDocker}`);
                const scriptPath = path.join(__dirname,"audiomanager.js");
                var child = spawn("node",[scriptPath, localid], pulse_opts);
                logger.info("Starting ","node",[scriptPath, localid]);
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
            },
            (cb) => {
                setTimeout(function() {
                    cb();
                }, 500);
            }
        ], function (err) {
            if (err) {
                logger.error("initAudio: " + err);
            }
            resolve();
        });
    });
}

function deInitAudio(localid) {
    return new Promise((resolve,reject) => {
        async.series([
            // kill the audio manager process
            function(callback) {
                var cmd = "node";
                var arg1 =  path.join(__dirname,"audiomanager.js");
                var arg2 =  localid;
                ps.lookup({
                    command: cmd,
                    arguments: [arg1, localid],
                    psargs: 'ax'
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
            resolve();
        });
    });
}

module.exports = {
    initAudio: initAudio,
    deInitAudio: deInitAudio

};
