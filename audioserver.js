"use strict";

var execFile = require('child_process').execFile;

var async = require('async');
var _ = require('underscore');

function startPulseaudioWrapper(callback) {
    callback(null);
}

function startUserAudioserver(opts, callback) {
    var platform = opts.platform;
    var unum = opts.unum;
    var logger = opts.logger;
    async.series(
        [
            function(callback) {
                platform.execFile("daemonize", ["user_audioserver", unum], function (err, stdout, stderr) {
                    if(err) {
                        logger.error("audioserver.js::startUserAudioserver Cannot start audioserver, err: " + err);
                        callback(null);
                    } else {
                        callback(null);
                    }
                });
            },
            function(callback) {
                platform.execFile("daemonize", ["user_mediaserver", unum], function (err, stdout, stderr) {
                    if(err) {
                        logger.error("audioserver.js::startUserAudioserver Cannot start audioserver, err: " + err);
                        callback(null);
                    } else {
                        callback(null);
                    }
                });
            }
        ], function(err) {
            callback(err);
        }
    );
}

function stopUserAudioserver(opts, callback) {
    var platform = opts.platform;
    var unum = opts.unum;
    var logger = opts.logger;
    async.waterfall(
        [
            function(callback) {
                var pids = [];
                var re_cmd1 = new RegExp("^user_audioserver " + unum + "$");
                var re_cmd2 = new RegExp("^user_mediaserver " + unum + "$");
                var re_ps_line = new RegExp("^[^ \t]+[ \t]+([0-9]*).*");
                execFile("ps", ["-aux"], function(error, stdout, stderr) {
                    var lines;
                    if (error) {
                        logger.error("audioserver.js::stopUserAudioserver ps failed, err: " + error);
                        return callback(error);
                    }
                    lines = stdout.split("\n");
                    var cmdStartPos = lines[0].indexOf("COMMAND");
                    lines.forEach(function(row) {
                        var cmdLine = row.slice(cmdStartPos);
                        if (re_cmd1.exec(cmdLine) || re_cmd2.exec(cmdLine)) {
                            var obj = re_ps_line.exec(row);
                            if(obj) {
                                pids.push(obj[1]);
                            }
                        }
                    });
                    callback(null, pids);
                });
            },
            function(pids, callback) {
                logger.info("pids: " + JSON.stringify(pids));
                if(pids.length) {
                    execFile("kill", pids, function(error, stdout, stderr) {
                        if (error) {
                            logger.error("audioserver.js::stopUserAudioserver kill failed, err: " + error);
                            return callback(error);
                        }
                        callback(null);
                    });
                } else {
                    callback(null);
                }
            }
        ], function(err) {
            callback(err);
        }
    );
}

module.exports = {
    startPulseaudioWrapper: startPulseaudioWrapper,
    startUserAudioserver: startUserAudioserver,
    stopUserAudioserver: stopUserAudioserver
};

