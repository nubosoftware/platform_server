"use strict";

var execFile = require('child_process').execFile;
var fs = require('fs');
var Common = require('./common.js');
var localPlatform = null;

var Platform = function(curLogger) {
    var logger = curLogger;
    
    this.execFile = function(cmd, args, callback) {
        var envNugat = {
            "_": "/system/bin/env",
            "ANDROID_DATA": "/data",
            "ANDROID_ROOT": "/system",
            "TMPDIR": "/data/local/tmp",
            "ANDROID_BOOTLOGO": "1",
            "ANDROID_ASSETS": "/system/app",
            "ASEC_MOUNTPOINT": "/mnt/asec",
            "BOOTCLASSPATH":
                "/system/framework/core-oj.jar"+
                ":/system/framework/core-libart.jar"+
                ":/system/framework/conscrypt.jar"+
                ":/system/framework/okhttp.jar"+
                ":/system/framework/core-junit.jar"+
                ":/system/framework/bouncycastle.jar"+
                ":/system/framework/ext.jar"+
                ":/system/framework/framework.jar"+
                ":/system/framework/telephony-common.jar"+
                ":/system/framework/voip-common.jar"+
                ":/system/framework/ims-common.jar"+
                ":/system/framework/apache-xml.jar"+
                ":/system/framework/org.apache.http.legacy.boot.jar",
            "HOSTNAME": "x86_platform",
            "EXTERNAL_STORAGE": "/sdcard",
            "ANDROID_STORAGE": "/storage",
            "PATH": "/sbin:/vendor/bin:/system/sbin:/system/bin:/system/xbin",
            "SYSTEMSERVERCLASSPATH": "/system/framework/services.jar:/system/framework/ethernet-service.jar:/system/framework/wifi-service.jar"
        };
        var execFileArgs = ["/Android", cmd].concat(args);
        var execFileOpts = {
            env: envNugat,
            timeout: 60 * 1000
        };
        execFile("/usr/sbin/chroot", execFileArgs, execFileOpts, function(error, stdout, stderr) {
            Common.logger.info("execFile command : chroot " + JSON.stringify(execFileArgs));
            Common.logger.info("execFile stdout " + stdout);
            Common.logger.info("execFile stderr " + stderr);
            callback(error, stdout, stderr);
        });
    };

    return this;
};

if (module) {
    module.exports = Platform;
}
