"use strict";
var Common = require('./common.js');
var logger = Common.logger;
var async = require('async');
var execFile = require('child_process').execFile;
var spawn = require('child_process').spawn;
var ps = require('ps-node');
var fs = require('fs');


// /Android/data/user/11/Session.xml

function getTagValue(xml,tag) {
    var re = new RegExp('<'+tag+'>(.+?)<\/'+tag+'>');
    var m = re.exec(xml);
    if (m !== null && m.length >= 2) {
        return m[1];
    } else {
        return null;
    }
}

function getUserConf(localid, cb) {
    fs.readFile("/Android/data/user/" + localid + "/Session.xml", 'utf8', function (err, xml) {        
        if (err) {
            logger.error("Error reading session xml file", err);
            cb(err)
            return;
        }
        logger.info("Session XML: " + xml);
        var conf = {
            platformID: getTagValue(xml, "platformID"),
            gateway_url: getTagValue(xml, "gateway_url"),
            gatewayRTPPort: getTagValue(xml, "gatewayRTPPort")
        };
        cb(null, conf);
        return;
    });
}



/**
 * Initialize pulse audio for sending audio stream
 */

function initAudio(localid, callback) {
    var re = new RegExp('(.+)[=:] (.+)');
    var re1 = new RegExp('nubo-pulseaudio-u([0-9]+)');

    function getParamValue(line) {

        var m = re.exec(line);
        if (m !== null && m.length >= 3) {
            return {
                param: m[1].trim(),
                value: m[2].trim()
            };
        } else {
            return null;
        }
    }

    var sinkkInputIdx;
    var sinkInputTries = 0;
    var userConf;

    var getSinkInput = function (callback) {
        execFile("pacmd", ["list-sink-inputs"], function (error, stdout, stderr) {
            var lines;
            var doneFlag = false;
            if (error) stdout = "";
            lines = stdout.split("\n");
            var curIndex = -1;
            lines.forEach(function (row) {
                if (doneFlag == false) {
                    var paramVal = getParamValue(row);
                    if (paramVal != null) {
                        if (paramVal.param == "index") {
                            curIndex = parseInt(paramVal.value);
                        }
                        if (paramVal.param == "application.name") {
                            var m1 = re1.exec(paramVal.value);
                            if (m1 !== null && m1.length >= 2) {
                                if (m1[1] == localid) { // we found the user input sink
                                    sinkkInputIdx = curIndex;
                                    doneFlag = true;
                                }
                            }
                        }
                    }
                }
            });
            if (doneFlag) callback(null);
            else {
                sinkInputTries++;
                if (sinkInputTries > 10) {
                    //callback("Cannot find sink input for too many times. give up...");
                    // debug only
                    callback(null);
                    return;
                }
                logger.info("Cannot find sink input for user " + localid + " will try again in a few seconds");
                setTimeout(function () {
                    getSinkInput(callback);
                }, 4 * 1000);
            }
        });

    };

    async.series([
        function (callback) {
            getUserConf(localid,function(err,res) {
                userConf = res;
                callback(err);
            });
        },
        function (callback) {
            getSinkInput(callback);
        },
        function (callback) {
            execFile("pactl", ["load-module", "module-null-sink", "sink_name=rtpu" + localid, "format=s16", "channels=2", "rate=48000", "sink_properties=\"device.description='RTP_U" + localid + "'\""], function (error, stdout, stderr) {
                if (error) {
                    logger.error("initAudio.pactl.load-module.module-null-sink: stdout: " + stdout);
                }
                callback(error);
            });
        },
        function (callback) {
            var ssrc = ((userConf.platformID & 0xFFFF) << 16) | (localid & 0xFFFF);
            var port = (userConf.gatewayRTPPort != null ? userConf.gatewayRTPPort : "60005");
            var cmd = "gst-launch-1.0";
            var params = ["pulsesrc","device=rtpu"+localid+".monitor", "!","audio/x-raw,channels=2", "!", "opusenc","bitrate-type=1", "!", "rtpopuspay", "ssrc="+ssrc, "!", "udpsink", "host="+userConf.gateway_url, "port="+port];
            var child = spawn(cmd, params);
            var userid = localid;
            child.stdout.on('data', (data) => {
                logger.info(`initAudio.gst-launch-1.0 userid: ${userid}, stdout: ${data}`);
            });

            child.stderr.on('data', (data) => {
                console.log(`initAudio.gst-launch-1.0 userid: ${userid}, stderr: ${data}`);
            });

            child.on('close', (code) => {
                logger.info(`initAudio.gst-launch-1.0 userid: ${userid}, child process exited with code ${code}`);
              });
            callback(null);
        },
        function (callback) {
            execFile("pactl", ["move-sink-input", "" + sinkkInputIdx, "rtpu" + localid], function (error, stdout, stderr) {
                if (error) {
                    logger.error("initAudio.pactl.move-sink-input: stdout: " + stdout);
                }
                callback(error);
            });
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
    var re = new RegExp('(.+)[=:] (.+)');

    function getParamValue(line) {

        var m = re.exec(line);
        if (m !== null && m.length >= 3) {
            return {
                param: m[1].trim(),
                value: m[2].trim()
            };
        } else {
            return null;
        }
    }

    var nullSinkID = 0;
    var nuboRtpSendID = 0;

    var findModules = function (callback) {
        execFile("pacmd", ["list-modules"], function (error, stdout, stderr) {
            var lines;
            var doneFlag = false;
            if (error) stdout = "";
            lines = stdout.split("\n");
            var curIndex = -1;
            var inNullSink = false;
            var inNuboRtp = false;
            lines.forEach(function (row) {
                if (doneFlag == false) {
                    var paramVal = getParamValue(row);
                    if (paramVal != null) {
                        if (paramVal.param == "index") {
                            curIndex = parseInt(paramVal.value);
                        }
                        if (paramVal.param == "name") {
                            inNullSink = false;
                            inNuboRtp = false;
                            if (paramVal.value == "<module-null-sink>" ) {
                                inNullSink = true;
                            }
                            if (paramVal.value == "<module-nubo-rtp-send>" ) {
                                inNuboRtp = true;
                            }
                        }
                        if (inNullSink == true && paramVal.param == "argument") {
                            if (paramVal.value.indexOf("sink_name=rtpu"+ localid+" ") > 0 ) {
                                nullSinkID = curIndex;
                            }
                        }
                        if (inNuboRtp == true && paramVal.param == "argument") {
                            if (paramVal.value.indexOf("rtpu"+ localid+".monitor") > 0 ) {
                                nuboRtpSendID = curIndex;
                            }
                        }
                    }
                }
            });
            if (nullSinkID > 0 || nuboRtpSendID > 0) callback(null);
            else {
                callback("Cannot find audio modules to unload");
            }
        });

    };

    async.series([
        // kill the gstreamer process
        function (callback) {
            var cmd = "gst-launch-1.0";
            var arg =  "device=rtpu"+localid+".monitor";
            ps.lookup({
                command: cmd//,
                //arguments: "device=rtpu"+localid+".monitor",
                }, function(err, resultList ) {
                if (err) {
                    logger.error("Unable to kill gst-launch-1.0, ps error: ",err);
                    callback(null);
                    return;
                }
                var processFound = false;
                resultList.forEach(function( process ){
                    if( process ){
                        logger.info( 'PID: %s, COMMAND: %s, ARGUMENTS: %s', process.pid, process.command, process.arguments );
                        var matchUser = (process.arguments.indexOf(arg) > -1);
                        if (matchUser) {
                            processFound = true;
                            ps.kill( process.pid, 'SIGINT', function( err ) {
                                if (err) {
                                    logger.error("Unable to kill gst-launch-1.0, kill error: ",err);
                                } else {
                                    logger.info( 'gst-launch-1.0 has been killed.');
                                }
                                return;
                            });
                        }
                    }
                });
                if (!processFound) {
                    logger.info( '"Unable to kill gst-launch-1.0, process not found.');
                }
                callback(null);
            });
        },
        function (callback) {
            findModules(callback);
        },
        /*
        function (callback) {
            if (nuboRtpSendID > 0) {
                execFile("pacmd", ["unload-module", nuboRtpSendID], function (error, stdout, stderr) {
                    if (error) {
                        logger.error("deInitAudio.unload-module: stdout: " + stdout);
                    }
                    callback(error);
                });
            } else {
                callback();
            }
        },*/
        function (callback) {
            if (nullSinkID > 0) {
                execFile("pacmd", ["unload-module", nullSinkID], function (error, stdout, stderr) {
                    if (error) {
                        logger.error("deInitAudio.unload-module: stdout: " + stdout);
                    }
                    callback(error);
                });
            } else {
                callback();
            }
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