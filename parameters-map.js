var filter = {
    "permittedMode": true,
    "rules": [{
        "path": "/",
        "constraints": {}
    }, {
        "path": "/startPlatform",
        "constraints": {}
    }, {
        "path": "/killPlatform",
        "constraints": {}
    }, {
        "path": "/attachUser",
        "constraints": {}
    }, {
        "path": "/createNewUserTarGz",
        "constraints": {}
    }, {
        "path": "/detachUser",
        "constraints": {
            "unum": {
                "numericality": {
                    "onlyInteger": true,
                    "greaterThan": 0
                }
            }
        }
    }, {
        "path": "/installApk",
        "constraints": {
            "apk": {
                "presence": true,
                "length": {
                    "minimum": 4
                },
                "format": {
                    "pattern": "^[A-Za-z0-9\\.\\-_\/]+\\.apk$"
                }
            }
        }
    }, {
        "path": "/attachApps",
        "constraints": {}
    }, {
        "path": "/getPackagesList",
        "constraints": {
            "filter": {
                "format": {
                    "pattern": "^[A-Za-z0-9\\.\\-_\\*]+$"
                }
            }
        }
    }, {
        "path": "/refreshMedia",
        "constraints": {}
    }, {
        "path": "/checkPlatformStatus",
        "constraints": {
            "username": {
                "presence": true,
                "format": {
                    "pattern": "^[A-Za-z0-9\\.\\-_@]+$"
                }
            },
            "deviceid": {
                "presence": true,
                "format": {
                    "pattern": "^[A-Za-z0-9\\.\\-_@]+$"
                }
            },
            "platformip": {
                "presence": true,
                "format": {
                    "pattern": "^[0-9]{1,3}.[0-9]{1,3}.[0-9]{1,3}.[0-9]{1,3}$"
                }
            }
        }
    }, {
        "path": "/applyFirewall",
        "constraints": {}
    }, {
        "path": "/connectToVpn",
        "constraints": {}
    }]
};

module.exports = filter;