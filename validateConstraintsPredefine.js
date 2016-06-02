"use strict";

var _ = require("underscore");
var validate = require("validate.js");
var constraints = {};

constraints.sessionIdConstr = {
    "format" : "[a-zA-Z0-9]+",
    "length" : {
        "minimum" : 1,
        "maximum" : 1000
    }
};

constraints.requestedSessionIdConstr = _.extend({presence: true}, constraints.sessionIdConstr);

constraints.loginTokenConstr = {
    "format" : "[a-z0-9]+",
    "length" : {
        "minimum" : 1,
        "maximum" : 100
    }
};

constraints.requestedLoginTokenConstr = _.extend({presence: true}, constraints.loginTokenConstr);

constraints.requestedIndexConstr = {
    presence: true,
    numericality: {
        onlyInteger: true,
        greaterThan: 0
    }
};

constraints.portConstr = {
    presence: true,
    numericality: {
        onlyInteger: true,
        greaterThan: 0
    }
};

constraints.ipConstr = {
    presence: true,
    format:{
        pattern: "^[0-9]{1,3}.[0-9]{1,3}.[0-9]{1,3}.[0-9]{1,3}$"
    }
};

constraints.boolConstr = {
    presence: true,
    inclusion: {
        within: [true, false, "true", "false"]
    }
};

constraints.hostConstr = {
    presence: true,
    format: "[a-zA-Z0-9\.\-\_]+",
    length: {
        "minimum" : 1,
        "maximum" : 1000
    }
};

constraints.pathConstr = {
    format: "[a-zA-Z0-9\.\/\@\\-\_]+",
    length: {
        "minimum" : 1,
        "maximum" : 1000
    }
};

validate.validators.array = function(value, options, key, attributes) {
    var itemConstraint = _.extend({}, options);
    var arr;
    if(validate.isArray(value)) {
        arr = value;
    } else {
        arr = [value];
    }

    var arrConstraint = _.mapObject(arr, function(val, key) {return itemConstraint;});
    var res = validate(arr, arrConstraint);
    return res;
};

validate.validators.isArray = function(value, options, key, attributes) {
    if(validate.isArray(value)) {
        return undefined;
    } else {
        return "is not array"
    }
};

module.exports = constraints;
