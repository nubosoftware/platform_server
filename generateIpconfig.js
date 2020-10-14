"use strict";

var net = require("net");
var os = require("os");
var async = require('async');
var execFile = require('child_process').execFile;
var fs = require('fs');
var common = require('./common.js');

function prepareEthernetDir(callback) {
    async.series(
        [
            function(callback) {
                var opts = {
                    mode: "0771",
                    uid: 1000,
                    gid: 9998
                };
                mkdirIfNotExist("/Android/data/misc", opts, callback);
            },
            function(callback) {
                var opts = {
                    mode: "0770",
                    uid: 1000,
                    gid: 1000
                };
                mkdirIfNotExist("/Android/data/misc/ethernet", opts, callback);
            }
        ], function(err) {
            callback(err);
        }
    );
}

function calculateNetmask(str) {
    var bytes = str.split('.');
    var res = 0;
    bytes.forEach(function(byte) {
        if(byte === "255") {
            res = res + 8;
        } else {
            res = res + Number(byte).toString(2).indexOf("0");
            return res;
        }
    });
    return res;
}

function prepareNetworkConfiguration(callback) {
    var ipconfig = {dns: []};
    if(common.proxy) {
        ipconfig.proxy = common.proxy;
    }
    var ninames, niname;
    async.series(
        [
            function(callback) {
                var ni = os.networkInterfaces();
                ninames = Object.keys(ni);
                niname = common.defaultNetworkInterface || ninames[1];
                if(ni[niname]) {
                    ipconfig.ipAddress = ni[niname][0]["address"];
                    ipconfig.ipAddressMask = calculateNetmask(ni[niname][0]["netmask"]);
                    callback(null);
                } else {
                    callback("invalid network interface");
                }
            },
            function(callback) {
                execFile("ip", ["r"], function(error, stdout, stderr) {
                    if (error) {
                        callback(error);
                    } else {
                        var lines = stdout.toString().split('\n');
                        var re = RegExp("default via \([^ ]*\) dev \([^ ]*\)");
                        lines.forEach(function(row) {
                            var m = re.exec(row);
                            if(m && (m[2] === niname)) {
                                ipconfig.gateway = m[1];
                            }
                        });
                        callback(null);
                    }
                });
            },
            function(callback) {
                fs.readFile("/etc/resolv.conf", function(err, data) {
                    if(err) {
                        callback(err);
                    } else {
                        var lines = data.toString().split('\n');
                        var re = RegExp("nameserver \([^ ]*\)");
                        lines.forEach(function(row) {
                            var m = re.exec(row);
                            if(m) {
                                ipconfig.dns.push(m[1]);
                            }
                        });
                        callback(null);
                    }
                });
            }
        ], function(err) {
            callback(err, ipconfig);
        }
    );
}

function createIpconfigTxt(ipconfig, callback) {
    var ipconfigTxtPath = "/Android/data/misc/ethernet/ipconfig.txt";
    var buf;
    var writeStream = fs.createWriteStream(ipconfigTxtPath);
    var writeInt = function(int) {
        var buf = new Buffer(4);
        buf.writeInt32BE(int, 0, 4);
        return writeStream.write(buf);
    };
    var writeString = function(str) {
        var len = str.length;
        var buf = new Buffer(len + 2);
        buf.writeInt16BE(len, 0, 2);
        buf.write(str, 2, len);
        return writeStream.write(buf);
    }
    var callbackDone = false;

    writeStream.cork();
    writeInt(2); //Version 2

    writeString("ipAssignment");
    writeString("STATIC");

    writeString("linkAddress");
    writeString(ipconfig.ipAddress);
    writeInt(ipconfig.ipAddressMask);

    if (ipconfig.gateway) {
        writeString("gateway");
        writeInt(0); // Default route.
        writeInt(1); // Have a gateway.
        writeString(ipconfig.gateway);
    }

    ipconfig.dns.forEach(function(row) {
        writeString("dns");
        writeString(row);
    });

    writeString("id");
    writeInt(0);    //1st network

    if(ipconfig.proxy) {
        if(ipconfig.proxy.proxyPac) {
            writeString("proxySettings");
            writeString("PAC");
            writeString("proxyPac");
            writeString(ipconfig.proxy.proxyPac);
        } else if(ipconfig.proxy.proxyHost && ipconfig.proxy.proxyPort) {
            writeString("proxySettings");
            writeString("STATIC");
            writeString("proxyHost");
            writeString(ipconfig.proxy.proxyHost);
            writeString("proxyPort");
            writeInt(ipconfig.proxy.proxyPort);
            if(ipconfig.proxy.exclusionList)
            writeString("exclusionList");
            writeString(ipconfig.proxy.exclusionList);
        }
    }

    writeString("eos");

    writeStream.on("finish", function() {
        if(!callbackDone) {
            callbackDone = true;
            callback(null);
        }
    });
    writeStream.on("error", function(err) {
        if(!callbackDone) {
            callbackDone = true;
            callback(err);
        }
    });
    fs.chown(ipconfigTxtPath, 1000, 1000, function() {});
    fs.chmod(ipconfigTxtPath, "0600", function() {});

    writeStream.end();
}

function setupAndroidStaticNetwork(callback) {
    var ipconfig;
    async.series(
        [
            function(callback) {
            //    console.log("prepareEthernetDir");
                prepareEthernetDir(callback);
            },
            function(callback) {
                //console.log("prepareNetworkConfiguration");
                prepareNetworkConfiguration(function(err, obj) {
                    if(err) {
                        callback(err);
                    } else {
                        ipconfig = obj;
                        callback(null);
                    }
                });
            },
            function(callback) {
                //console.log("createIpconfigTxt");
                createIpconfigTxt(ipconfig, callback);
            }
        ], function(err) {
            callback(null);
        }
    );
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

module.exports = {
    setupAndroidStaticNetwork: setupAndroidStaticNetwork
};



