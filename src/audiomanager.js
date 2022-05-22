"use strict";

/**
 * AudioManager
 * Manage the audio streams of user session. This service should be executed for each user after login
 */

var async = require('async');
var execFile = require('child_process').execFile;
var spawn = require('child_process').spawn;
var fs = require('fs');
var net = require('net');

var localid;
var nullSinkIn,nullSinkOut;
var gstRecordProc;
var pulseaudioUserProc;

var args = process.argv;
if (args.length < 3) {
    console.info("Usage node audiomanager.js [localid]");
    return;
}
localid = Number(args[2]);
if (isNaN(localid)) {
    console.error("Invalid localid");
    console.info("Usage node audiomanager.js [localid]");
    return;
}

function getTagValue(xml, tag) {
    var re = new RegExp('<' + tag + '>(.+?)<\/' + tag + '>');
    var m = re.exec(xml);
    if (m !== null && m.length >= 2) {
        return m[1];
    } else {
        return null;
    }
}

function getUserConf(localid, cb) {
    var fileName = "./sessions/localid_" + localid + ".json";
    fs.readFile(fileName, 'utf8', function (err, str) {
        if (err) {
            console.error("Error reading session description file", err);
            return cb(err);
        }
        var data = JSON.parse(str);

        if(data.params.audioStreamParams) {
            var split = data.params.audioStreamParams.split(":");
            if(split.length === 3) {
                var conf = {
                    platformID: data.params.platid,
                    rtpOutHost: split[0],
                    rtpOutPort: split[1],
                    rtpInPort: split[2],
                    enableAudio: true
                };
                return cb(null, conf);
            } else {
                return cb("invalid data in audioStreamParams field");
            }
        } else {
            return cb(null, {enableAudio: false});
        }
    });
}

function hrtimeDiffMs(end, start) {
    return (end[0]-start[0])*1000 + (end[1] - start[1])/1000000;
}

var startAudioManager = function () {
    console.info("Starting Audio Manager...");
    var userConf;

    var sinkInputPlayerIdx = -1;
    var sinkInputRecorderIdx = -1;
    var sourceOutputRecorderIdx = -1;
    var sinkInputTries = 0;

    var re = new RegExp('(.+)[=:] (.+)');
    var re1 = new RegExp('nubo-pulseaudio-u([0-9]+)');
    var re2 = new RegExp('nubo-gst-u([0-9]+)');

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

    var getSinkInputs = function(callback) {
        execFile("pacmd", ["list-sink-inputs"], function(error, stdout, stderr) {
            var lines;
            var doneFlag = false;
            //console.info("list-sink-inputs: "+stdout);
            if (error) stdout = "";
            lines = stdout.split("\n");
            var curIndex = -1;
            lines.forEach(function(row) {
                if (doneFlag === false) {
                    var paramVal = getParamValue(row);
                    if (paramVal !== null) {
                        if (paramVal.param === "index") {
                            curIndex = parseInt(paramVal.value);
                        }
                        if (paramVal.param === "application.name") {
                            //console.info("application.name: '"+paramVal.value+"'");
                            var m1 = re1.exec(paramVal.value);
                            if (m1 !== null && m1.length >= 2) {
                                if (Number(m1[1]) === localid) { // we found the user input sink
                                    console.info("Found sinkInputPlayerIdx: "+curIndex);
                                    sinkInputPlayerIdx = curIndex;
                                }
                            }
                            var m2 = re2.exec(paramVal.value);
                            if (m2 !== null && m2.length >= 2) {
                                if (Number(m2[1]) === localid) { // we found the user input sink
                                    console.info("Found sinkInputRecorderIdx: "+curIndex);
                                    sinkInputRecorderIdx = curIndex;
                                    //doneFlag = true;
                                }
                            }
                            if (sinkInputPlayerIdx>=0 && sinkInputRecorderIdx>=0) {
                                doneFlag = true;
                            }
                        }
                    }
                }
            });
            if (doneFlag)  {
                console.info("Found sink player input. index: "+sinkInputPlayerIdx);
                console.info("Found sink recorder input. index: "+sinkInputRecorderIdx);
                callback(null)
            } else {
                sinkInputTries++;
                if (sinkInputTries > 10) {
                    callback("Cannot find sink input for too many times. give up...");
                    // debug only
                    //callback(null);
                    return;
                }
                console.info("Cannot find sink input for user " + localid + " will try again in a few seconds, sinkInputPlayerIdx: "+sinkInputPlayerIdx+", sinkInputRecorderIdx: "+sinkInputRecorderIdx);
                setTimeout(function() {
                    getSinkInputs(callback);
                }, 4 * 1000);
            }
        });

    };

    var getSourceOutputs = function(callback) {
        execFile("pacmd", ["list-source-outputs"], function(error, stdout, stderr) {
            var lines;
            var doneFlag = false;
            //console.info("list-source-outputs: "+stdout);
            if (error) stdout = "";
            lines = stdout.split("\n");
            var curIndex = -1;
            lines.forEach(function(row) {
                if (doneFlag === false) {
                    var paramVal = getParamValue(row);
                    if (paramVal !== null) {
                        if (paramVal.param === "index") {
                            curIndex = parseInt(paramVal.value);
                        }
                        if (paramVal.param === "application.name") {
                            console.info("application.name: '"+paramVal.value+"'");
                            if(paramVal.value === "\"nubo-pulseaudio-u" + localid + "\"") {
                                sourceOutputRecorderIdx = curIndex;
                                doneFlag = true;
                            }
                        }
                    }
                }
            });
            if (doneFlag)  {
                console.info("Found source outputs index: " + sourceOutputRecorderIdx);
                callback(null);
            } else {
                sinkInputTries++;
                if (sinkInputTries > 10) {
                    callback("Cannot find source output too many times. give up...");
                    // debug only
                    //callback(null);
                    return;
                }
                console.info("Cannot find source output for user " + localid + " will try again in a few seconds, sourceOutputRecorderIdx: "+sourceOutputRecorderIdx);
                setTimeout(function() {
                    getSourceOutputs(callback);
                }, 4 * 1000);
            }
        });

    };

    async.series([
        // reading session configuration
        function (callback) {
            getUserConf(localid, function (err, res) {
                userConf = res;
                if (err) {
                    callback(err);
                } else {
                    if (userConf.enableAudio) {
                        callback(null);
                    } else {
                        callback("Audio is not enabled");
                    }
                }
            });
        },
        (cb) => {
            var args = [
                localid,
                userConf.rtpOutHost,
                userConf.rtpOutPort,
                ((userConf.platformID & 0xFFFF) << 16) | (localid & 0xFFFF)
            ];
            //console.info(`Spawn pulseaudio-user. args: ${args}`);
            var child = spawn("./dist/pulseaudio-user", args);
            var userid = localid;
            child.stdout.on('data', (data) => {
                console.info(`pulseaudio-user userid: ${userid}, stdout: ${data}`);
            });

            child.stderr.on('data', (data) => {
                console.log(`pulseaudio-user userid: ${userid}, stderr: ${data}`);
            });

            child.on('close', (code) => {
                console.info(`pulseaudio-user userid: ${userid}, child process exited with code ${code}`);
                pulseaudioUserProc = undefined;
            });
            console.info(`Spawned pulseaudio-user child pid: ${child.pid}`);
            pulseaudioUserProc = child;
            cb();
        },
        // start gst for input stream
        (cb) => {
            var cmd = "gst-launch-1.0";
            var params = ["udpsrc", "port=" + userConf.rtpInPort, "caps=\"application/x-rtp, media=(string)audio, clock-rate=(int)48000, encoding-name=(string)OPUS, encoding-params=(string)2, channels=(int)1, payload=(int)96\"", "!",
               // "rtpjitterbuffer", "!",
                "rtpopusdepay", "!",
                "opusdec", "!",
                "audio/x-raw,rate=8000,channels=1", "!",
                "audioconvert", "!",
                "pulsesink", "client-name=\"nubo-gst-u"+localid+"\"","stream-properties=\"props,device.buffering.buffer_size=640\"" ];
            console.info(cmd,params);
            var child = spawn(cmd,params);
            var userid = localid;
            child.stdout.on('data', (data) => {
                console.info(`initAudio.gst-launch-1.0 userid: ${userid}, stdout: ${data}`);
            });

            child.stderr.on('data', (data) => {
                console.log(`initAudio.gst-launch-1.0 userid: ${userid}, stderr: ${data}`);
            });

            child.on('close', (code) => {
                console.info(`initAudio.gst-launch-1.0 userid: ${userid}, child process exited with code ${code}`);
                gstRecordProc = undefined;
            });
            console.info(`Spawned gst-launch-1.0 child pid: ${child.pid}`);
            gstRecordProc = child;
            cb();
        },
        // find sink input of the player
        (cb) => {
            getSinkInputs(cb);
        },
        (cb) => {
            getSourceOutputs(cb);
        },
        // create a null sink to redirect output of player
        (cb) => {
            execFile("pactl", ["load-module", "module-null-sink", "sink_name=rtpu" + localid, "format=s16", "channels=2", "rate=44100", "sink_properties=\"device.description='RTP_U" + localid + "'\""], function(error, stdout, stderr) {
                if (error) {
                    console.error("initAudio.pactl.load-module.module-null-sink: stdout: " + stdout);
                } else {
                    nullSinkOut = Number(stdout.trim());
                }
                cb(error);
            });
        },
        // create a null sink to redirect input of recorder
        (cb) => {
            execFile("pactl", ["load-module", "module-null-sink", "sink_name=recu" + localid, "format=s16", "channels=1", "rate=8000", "sink_properties=\"device.description='REC_U" + localid + "'\""], function(error, stdout, stderr) {
                if (error) {
                    console.error("initAudio.pactl.load-module.module-null-sink: stdout: " + stdout);
                } else {
                    nullSinkIn = Number(stdout.trim());
                }
                cb(error);
            });
        },
        // redirect output of the player to the sink input that will connect to gst
        (cb) => {
            console.log("run: pacmd move-sink-input " + sinkInputPlayerIdx + " rtpu" + localid);
            execFile("pacmd", ["move-sink-input", "" + sinkInputPlayerIdx, "rtpu" + localid], function(error, stdout, stderr) {
                if (error) {
                    console.error("initAudio.pactl.move-sink-input: stdout: " + stdout);
                }
                cb(error);
            });
        },
        // redirect input of the recorder
        (cb) => {
            execFile("pacmd", ["move-sink-input", "" + sinkInputRecorderIdx, "recu" + localid], function(error, stdout, stderr) {
                if (error) {
                    console.error("initAudio.pactl.move-sink-input: stdout: " + stdout);
                }
                cb(error);
            });
        },
        (cb) => {
            execFile("pacmd", ["move-source-output", "" + sourceOutputRecorderIdx, "recu" + localid + ".monitor"], function(error, stdout, stderr) {
                if (error) {
                    console.error("initAudio.pactl.move-source-output: stdout: " + stdout);
                }
                cb(error);
            });
        },
    ], function (err) {
        if (err && err !== "Audio is not enabled") {
            console.error("startAudioManager error", err);
            stopAudioManager();
            return;
        }
        console.info("Audio Manager initiated.");
    });

};

var stopAudioManager = function () {

    function terminateStream(stream,cb) {
        var cbCalled = false;
        stream.on('state', function(state){
            console.info("Stream state change to: "+state);
            if (state === "terminated") {
                if (!cbCalled) {
                    cbCalled = true;
                    cb(null);
                }
            }
        });
        stream.on('error', function(err){
            console.info("Terminate stream error",err);
            if (!cbCalled) {
                cbCalled = true;
                cb(null);
            }
        });
        stream.end();
    }
    async.series([
        (cb) => {
            if (nullSinkIn > 0) {
                execFile("pacmd", ["unload-module", nullSinkIn], function (error, stdout, stderr) {
                    if (error) {
                        console.error("deInitAudio.unload-module: stdout: " + stdout);
                    }
                    cb();
                });
            } else {
                cb();
            }
        },
        (cb) => {
            if (nullSinkOut > 0) {
                execFile("pacmd", ["unload-module", nullSinkOut], function(error, stdout, stderr) {
                    if (error) {
                        console.error("deInitAudio.unload-module: stdout: " + stdout);
                    }
                    cb();
                });
            } else {
                cb();
            }
        },
        (cb) => {
            if (gstRecordProc) gstRecordProc.kill('SIGINT');
            if (pulseaudioUserProc) pulseaudioUserProc.kill('SIGINT');
            cb();
        },
        (cb) => {
            let cnt = 0;
            var checkKilled = function(callback) {
                var needWaitFlag = false;
                if(gstRecordProc && !gstRecordProc.killed) {
                    console.info("waiting for quit of gst-lunch of record");
                    needWaitFlag = true;
                }
                if(pulseaudioUserProc && !pulseaudioUserProc.killed) {
                    console.info("waiting for quit of pulseaudio-user");
                    needWaitFlag = true;
                }
                cnt++;
                if(needWaitFlag && cnt < 60) {

                    setTimeout(function() {
                        checkKilled(callback);
                    }, 1000);
                } else {
                    if (cnt >= 60) {
                        console.error("Waiting too much for processes to quit");
                    }
                    callback();
                }
            }
            checkKilled(cb);
        }
    ], function (err) {
        if (err) {
            console.error("stopAudioManager error", err);
        }
        console.info("Audio Manager stopped.");
        process.exit();
    });
};


process.on("SIGINT", function () {
    console.log('CLOSING [SIGINT]');
    stopAudioManager();

});


startAudioManager();