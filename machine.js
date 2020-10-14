"use strict";

var net = require("net");
var path = require("path");
var url = require("url");
var async = require('async');
var _ = require('underscore');
const dns = require('dns');
var execFile = require('child_process').execFile;
var ThreadedLogger = require('./ThreadedLogger.js');
var Platform = require('./platform.js');
var fs = require('fs');
var common = require('./common.js');

var flagInitAndroidStatus = 0; // 0: not yet done, 1: in progress, 2: done
var RESTfull_message = "the platform not yet initialized";

function startPlatformGet(req, res) {
    var resobj = {
        status: 1,
        msg: RESTfull_message,
        androidStatus: flagInitAndroidStatus
    };
    res.end(JSON.stringify(resobj, null, 2));
}

function startPlatformPost(req, res) {
    var logger = new ThreadedLogger();
    var requestInProgress = true;

    if (flagInitAndroidStatus > 0) {
        var resobj = { status: 0 };
        if (flagInitAndroidStatus === 1) resobj.msg = "Init Android OS in progress";
        if (flagInitAndroidStatus === 2) resobj.msg = "Init Android OS already done";
        res.end(JSON.stringify(resobj, null, 2));
        return;
    }
    flagInitAndroidStatus = 1;
    var requestKeepAliveInterval = setInterval(
        function() {
            res.writeContinue();
        },
        1000
    );

    logger.logTime("Start process request startPlatform");
    var requestObj = req.body;
    if(requestObj.proxy) common.proxy = requestObj.proxy;

    async.waterfall(
        [
            function(callback) {
                RESTfull_message = "preset platform parameters";
                logger.info(RESTfull_message);
                setParametersOnMachine(requestObj, logger, callback);
            },
            function(callback) {
                getFiles(requestObj, logger, callback);
            },
            function(callback) {
                logger.debug("startPlatform: preconfigure vpn");
                preVpnConfiguration(logger, callback);
            },
            function(callback) {
                RESTfull_message = "init android";
                logger.info(RESTfull_message);
                initAndroid(requestObj, logger, callback);
            },
            function(callback) {
                RESTfull_message = "post boot procedures";
                logger.info(RESTfull_message);
                afterInitAndroid(requestObj, logger, callback);
            }
        ],
        function(err) {
            clearInterval(requestKeepAliveInterval);
            var resobj = {};
            if (err) {
                RESTfull_message = "Start android failed";
                logger.error("Error during start platform: " + err);
                resobj.status = 0;
                resobj.msg = err;
                flagInitAndroidStatus = 3;
            } else {
                RESTfull_message = "Android run";
                resobj.status = 1;
                flagInitAndroidStatus = 2;
            }
            res.end(JSON.stringify(resobj, null, 2));
            logger.logTime("Finish process request startPlatform");
        });
}

function killPlatform(req, res) {
    var resobj;
    resobj.status = 0;
    resobj.msg = "Not implemented";
    res.end(JSON.stringify(resobj, null, 2));
}

function fixHostsFile(path, ip, managementUrl, callback) {
    var managementUrlObj = url.parse(managementUrl);
    if (net.isIP(managementUrlObj.hostname)) {
        callback(null);
    } else {
        var hostsLine = ip + ' ' + managementUrlObj.hostname + '\n';
        fs.readFile(path, function(err, data) {
            if(err) {
                callback(err)
            } else {
                if(data.indexOf(hostsLine) === -1) {
                    fs.appendFile(path, hostsLine, callback);
                } else {
                    callback(null);
                }
            }
        });
    }
}

function mkdirIfNotExist(dir, opts, callback) {
    async.series(
        [
            function(callback) {
                fs.mkdir(dir, function(err) {
                    if(err) {
                        if (err.code === 'EEXIST') {
                            callback("exist");
                        } else {
                            callback(err);
                        }
                    } else {
                        callback(null);
                    }
                });
            },
            function(callback) {
                fs.chown(dir, opts.uid, opts.gid, callback);
            },
            function(callback) {
                fs.chmod(dir, opts.mode, callback);
            }
        ], function(err) {
            if(err === "exist") callback(null);
            else callback(err);
        }
    );
}

var setParametersOnMachine = function(obj, logger, callback) {
    async.series(
        [
            function(callback) {
                fixHostsFile("/etc/hosts", obj.management.ip, obj.management.url, callback);
            },
            function(callback) {
                execFile("modprobe", ["nfs"], function(error, stdout, stderr) {
                    if (error) {
                        logger.error("setParametersOnMachine: modprobe nfs fail stdout: " + stdout);
                    }
                    callback(error);
                });
            },
            function(callback) {
                execFile("modprobe", ["nubouserfs"], function(error, stdout, stderr) {
                    if (error) {
                        logger.error("setParametersOnMachine: modprobe nubouserfs fail stdout: " + stdout);
                    }
                    callback(error);
                });
            },
        ],
        function(err) {
            callback(err);
        }
    );
};

var xmlEncode = function(obj) {
    if (!obj) return "";
    var str = String(obj);
    return str.replace(/&/g, '&amp;')
               .replace(/</g, '&lt;')
               .replace(/>/g, '&gt;')
               .replace(/"/g, '&quot;')
               .replace(/'/g, '&apos;');
}

var initAndroid = function(reqestObj, logger, callback) {
    async.series(
        [
            function(callback) {
                var cmd = "/opt/Android/init-files.sh";
                execFile(cmd, [], function(error, stdout, stderr) {
                    if (error) {
                        logger.error("cmd: " + cmd);
                        logger.error("error: " + JSON.stringify(error, null, 2));
                        logger.error("stdout: " + stdout);
                        logger.error("stderr: " + stderr);
                    }
                    callback(error);
                });
            },
            function(callback) {
                var opts = {
                    mode: "0700",
                    uid: 0,
                    gid: 0
                };
                mkdirIfNotExist("/Android/data/mnt", opts, callback);
            },
            function(callback) {
                var cmd = "/usr/bin/pulseaudio";
                execFile(cmd, ["--start", "--daemonize=yes"], function(error, stdout, stderr) {
                    if (error) {
                        logger.error("cmd: " + cmd);
                        logger.error("error: " + JSON.stringify(error, null, 2));
                        logger.error("stdout: " + stdout);
                        logger.error("stderr: " + stderr);
                    }
                    callback(error);
                });
            },
            function(callback) {
                var sessionXmlContent =
                    "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n" +
                    '<session>\n' +
                    '<gateway_controller_port>' + reqestObj.gateway.controller_port + '</gateway_controller_port>\n' +
                    '<gateway_apps_port>' + reqestObj.gateway.apps_port + '</gateway_apps_port>\n' +
                    '<gateway_url>' + reqestObj.gateway.internal_ip + '</gateway_url>\n' +
                    '<platformID>' + reqestObj.platid + '</platformID>\n' +
                    '<management_url>' + reqestObj.management.url + '</management_url>\n' +
                    '<platform_uid>' + reqestObj.platUID + '</platform_uid>\n';
                var additionalSettings = reqestObj.settings.additionalSettings;
                if (additionalSettings) {
                    for (var k in additionalSettings) {
                        if (additionalSettings.hasOwnProperty(k)) {
                            var xmlKey = xmlEncode(k);
                            sessionXmlContent += '<'+xmlKey+'>' + xmlEncode(additionalSettings[k]) + '</'+xmlKey+'>\n';
                        }
                    }
                }
                sessionXmlContent +=  '</session>\n';
                fs.writeFile("/Android/data/data/Session.xml", sessionXmlContent, function(err) {
                    if (err) {
                        logger.error('setParametersOnMachine: ' + err);
                        callback(err);
                    } else {
                        logger.info("setParametersOnMachine: Session.xml created");
                        callback(null);
                    }
                });
            },
            function(callback) {
                fs.chmod("/Android/data/data/Session.xml", 0o644, callback);
            },
            function(callback) {
                fixHostsFile("/Android/system/etc/hosts", reqestObj.management.ip, reqestObj.management.url, callback);
            },
            function(callback) {
                require('./generateIpconfig.js').setupAndroidStaticNetwork(callback);
            },
            //function(callback) {
            //    fs.chmod("/Android/system/xbin", 0o750, callback);
            //},
            function(callback) {
                var chroot_proc = require('child_process').spawn(
                    "nohup", [
                        "/usr/sbin/chroot", "/Android", "/init"
                    ], {
                        stdio: ["ignore", "ignore", "ignore"],
                        detached: true,
                        shell: "/bin/sh"
                    }
                );
                //chroot_proc.on('close', function(code) {
                //    logger.error('setParametersOnMachine: chroot /Android /init finished with code ' + code);
                //});
                chroot_proc.unref();
                callback(null);
            }
        ],
        function(err) {
            callback(err);
        }
    );
};

var afterInitAndroid = function(reqestObj, logger, callback) {
    var platform = new Platform(logger);
    async.series(
        [
            function(callback) {
                setTimeout(function() { callback(null); }, 10 * 1000);
            },
            function(callback) {
                var cmd = "touch";
                execFile(cmd, ["/Android/dev/socket/syslog"], function(error, stdout, stderr) {
                    if (error) {
                        logger.error("cmd: " + cmd);
                        logger.error("error: " + JSON.stringify(error, null, 2));
                        logger.error("stdout: " + stdout);
                        logger.error("stderr: " + stderr);
                    }
                    callback(error);
                });
            },
            function(callback) {
                var cmd = "mount";
                var args = [
                    "--bind",
                    "/run/systemd/journal/dev-log",
                    "/Android/dev/socket/syslog"
                ];
                execFile(cmd, args, function(error, stdout, stderr) {
                    if (error) {
                        logger.error("cmd: " + cmd);
                        logger.error("error: " + JSON.stringify(error, null, 2));
                        logger.error("stdout: " + stdout);
                        logger.error("stderr: " + stderr);
                    }
                    callback(error);
                });
            },
            function(callback) {
                var nfsoptions = "nolock,hard,intr,noatime,async"; //user 0
                // nfs_path checked in validator for path traversal
                var src = [
                    reqestObj.nfs.nfs_ip + ":" + reqestObj.nfs.nfs_path + "/apks"
                ];
                var dst = [
                    "/Android/data/tmp"
                ];
                require('./mount.js').mountHostNfs(src, dst, nfsoptions, function(err) {
                    if (err) {
                        logger.error("Cannot mount apks, err: " + err);
                    }
                    callback(err);
                });
            },
            function(callback) {
                var timeoutSec = 900;
                logger.info("Waiting upto " + timeoutSec + " seconds for 1st boot of android...");
                waitForProcessWithTimeout("android.process.media", timeoutSec, callback);
            },
            function(callback) {
                setTimeout(function() { callback(null); }, 30 * 1000);
            },
            function(callback) {
                platform.execFile("pm", ["refresh", "0"], function(err, stdout, stderr) {
                    callback(null);
                });
            },
            function(callback) {
                var timeoutSec = 300;
                logger.info("Waiting upto " + timeoutSec + " seconds for restart of android...");
                waitForProcessWithTimeout("android.process.media", timeoutSec, callback);
            },
            function(callback) {
                if (reqestObj.settings.withService) {
                    platform.execFile("setprop", ["ro.kernel.withService", "withService"], function(err, stdout, stderr) {
                        callback(null);
                    });
                } else
                    callback(null);
            },
            function(callback) {
                if (reqestObj.settings.hideControlPanel) {
                    platform.execFile("setprop", ["ro.kernel.hideControlPanel", "hideControlPanel"], function(err, stdout, stderr) {
                        callback(null);
                    });
                } else
                    callback(null);
            },
            function(callback) {
                setTimeout(function() { callback(null); }, 10 * 1000);
            },
            function(callback) {
                execFile("/Android/system/bin/enable_houdini", [], function(err, stdout, stderr) {
                    logger.info("Houdini: " + err + " OUT=" + stdout + " ERR=" + stderr);

                    callback(null);
                });
            },
            function(callback) {
                if (common.additionalNetworkInterface) {
                    execFile("dhclient", [common.additionalNetworkInterface], function(err, stdout, stderr) {
                        logger.info("dhclient "+common.additionalNetworkInterface+": " + err + " OUT=" + stdout + " ERR=" + stderr);
                        callback(null);
                    });
                } else {
                    callback(null);
                }
            }

        ],
        function(err) {
            callback(err);
        }
    );
};

function checkPlatform(req, res) {
    var logger = new ThreadedLogger();
    logger.info("Running checkPlatform");
    var platform = new Platform(logger);
    async.series( [
        // check the ability to run pm commands on the android shell
        (cb) => {
            platform.execFile("pm", ["list", "users"], function(err, stdout, stderr) {
                var resobj;
                if (err) {
                    logger.error("checkPlatform. Andorid access error: "+ err);
                    cb("PM is not available: "+err);
                } else {
                    logger.info("Android is up. pm output: " + stdout);
                    cb(null);
                }
            });
        },
        // check DNS
        (cb) => {
            dns.lookup('gw.nubosoftware.com', (err, address, family) => {
                if (err) {
                    logger.error("checkPlatform. DNS error: "+ err);
                    cb("DNS is not working: "+err);
                } else {
                    logger.info("DNS is up: "+address);
                    cb(null);
                }
            });
        }
    ],(err) => {
        var resobj;
        if (err) {
            resobj = {
                status: 0,
                msg: "Platform error: " + err
            };
        } else {
            resobj = {
                status: 1,
                msg: "Platform is alive, no error found"
            };
        }
        res.end(JSON.stringify(resobj, null, 2));
    });

}

var waitForProcessWithTimeout = function(name, timeoutSec, callback) {
    var timeoutFlag = false;
    var timeoutObj = setTimeout(function() {
        timeoutFlag = true;
    }, timeoutSec * 1000); // setTimeout
    var re1 = new RegExp("^" + name + "\\b");
    var re2 = new RegExp("^[^ ]*/" + name + "\\b");
    var re3 = new RegExp("^\\[" + name + "\\]");

    var getPid = function(callback) {
        if (timeoutFlag) callback("timeout");
        else {
            execFile("ps", ["-aux"], function(error, stdout, stderr) {
                var lines;
                var doneFlag = false;
                if (error) stdout = "";
                lines = stdout.split("\n");
                var cmdStartPos = lines[0].indexOf("COMMAND");
                lines.forEach(function(row) {
                    var cmdLine = row.slice(cmdStartPos);
                    if (re1.exec(cmdLine) || re2.exec(cmdLine) || re3.exec(cmdLine)) {
                        clearTimeout(timeoutObj);
                        doneFlag = true;
                        console.log("row: " + row);
                    }
                });
                if (doneFlag) callback(null);
                else {
                    setTimeout(function() {
                        getPid(callback);
                    }, 4 * 1000);
                }
            });
        }
    };
    getPid(callback);
};

//remove symbol / from end of management url
var normalizeServerURL = function(url) {
    return url.replace(/[\/]+$/, "");
};

var getFiles = function(reqestObj, logger, callback) {
    var wgetArgsList;
    if (reqestObj.downloadFilesList) {
        wgetArgsList = _.map(reqestObj.downloadFilesList, function(item) {
            var wgetInput = normalizeServerURL(reqestObj.management.url) + item;
            // item already tested for path traversal in validation
            var wgetOutput = "/opt/Android/" + path.basename(item);
            return [wgetInput, "-qO", wgetOutput];
        });
    } else {
        logger.info("Start android without files updating");
        return callback(null);
    }
    logger.info("wget arguments: " + JSON.stringify(wgetArgsList));

    async.series(
        [
            function(callback) {
                async.eachSeries(
                    wgetArgsList,
                    function(item, callback) {
                        execFile("wget", item, function(error, stdout, stderr) {
                            if (error) {
                                logger.error("Cannot download file " + item[0] + ", err: " + error);
                            }
                            callback(error);
                        });
                    },
                    callback
                );
            }
        ],
        function(err) {
            if (err) {
                logger.error("getFiles failed with err: " + err);
            }
            callback(err);
        }
    );
};

function preVpnConfiguration(logger, callback) {
    async.series([
        //must load iptables before android platform starts, so netd can config init rules
        function(callback) {
            execFile("modprobe", ["iptable_nat"], function(error, stdout, stderr) {
                if (error) {
                    logger.debug("preVpnConfiguration: stdout: " + stdout);
                }
                callback(error);
            });
        },
        function(callback) {
            execFile("modprobe", ["iptable_raw"], function(error, stdout, stderr) {
                if (error) {
                    logger.error("preVpnConfiguration: stdout: " + stdout);
                }
                callback(error);
            });
        },
        function(callback) {
            execFile("modprobe", ["iptable_mangle"], function(error, stdout, stderr) {
                if (error) {
                    logger.error("preVpnConfiguration: stdout: " + stdout);
                }
                callback(error);
            });
        },
        function(callback) {
            execFile("modprobe", ["iptable_filter"], function(error, stdout, stderr) {
                if (error) {
                    logger.error("preVpnConfiguration: stdout: " + stdout);
                }
                callback(error);
            });
        },
        function(callback) {
            execFile("modprobe", ["tun"], function(error, stdout, stderr) {
                if (error) {
                    logger.error("preVpnConfiguration: stdout: " + stdout);
                }
                callback(error);
            });
        },
        /*
                    // need to load for legacy vpn
                    function(callback) {
                        execFile("modprobe", ["pppolac"], function(error, stdout, stderr) {
                            if(error){
                                logger.error("preVpnConfiguration: stdout: " + stdout);
                            }
                            callback(error);
                        });
                    },
                    // need to load for legacy vpn
                    function(callback) {
                        execFile("modprobe", ["pppopns"], function(error, stdout, stderr) {
                            if(error){
                                logger.error("preVpnConfiguration: stdout: " + stdout);
                            }
                            callback(error);
                        });
                    },*/
        // since vpn requires asymetric routing this parameter need to be set so
        // each new interface will be set with it (only vpn new interfaces should created)
        function(callback) {
            execFile("sysctl", ["net.ipv4.conf.default.rp_filter=2"], callback);
        }
    ], function(err) {
        if (err) {
            logger.error("preVpnConfiguration: " + err);
        }
        callback(err);
    });
}

module.exports = {
    startPlatformGet: startPlatformGet,
    startPlatformPost: startPlatformPost,
    killPlatform: killPlatform,
    checkPlatform: checkPlatform
};
