var e = require("../../util/error.json");
var util = require("../../util/util");
var project = require("../../model/projectModel")
var group = require("../../model/groupModel")
var interface = require("../../model/interfaceModel")
var status = require("../../model/statusModel")
var blue = require("bluebird");
var fs = require("fs");
var uuid = require("uuid/v1");
var request = require("../../third/requestAsync");
blue.promisifyAll(fs);

function Sync() {
    this.syncSwagger = async (req, res) => {
        try {
            let objProject = await (project.findOneAsync({ _id: req.clientParam.id }));
            if (!objProject) { return util.throw(e.projectNotFound, "项目不存在"); }
            req.interfaceModel = interface;
            req.groupModel = group;
            req.statusModel = status;

            let data = req.clientParam.json;
            if (req.clientParam.url) {
                data = await (request({ method: "GET", url: req.clientParam.url }).then(function (response) { return response.body; }))
            }
            let obj = JSON.parse(data);
            if (!obj.openapi) {
                return util.throw(e.commonError, "仅支持OpenAPI 3");
            }

            // 项目信息 名称/简介
            if (obj.info.title) { objProject.name = obj.info.title; }
            if (obj.info.description) { objProject.dis = obj.info.description; }

            // 更新工程
            objProject.source = req.clientParam.url ? { type: 0, url: req.clientParam.url } : { type: 0 }

            // 环境变量
            if (obj.servers) {
                let baseUrls = [];
                let url = obj.servers;
                url.forEach(function (i) {
                    baseUrls.push({ url: i.url, remark: i.description ? i.description : '' });
                });
                objProject.baseUrls = baseUrls;
            }

            // 环境注入
            objProject.before = "header[\"Content-Type\"]=\"application/json\"\nheader[\"Authorization\"]=\"ALWAYS_FOR_DEVTEST\"";
            await (objProject.saveAsync());

            // 重置接口
            if (req.clientParam.new) {
                await (req.groupModel.deleteMany({ project: objProject._id, type: 0 }, function () { }));
                await (req.interfaceModel.deleteMany({ project: objProject._id }, function () { }));
            }

            // 同步标签
            let noName = "#未分类";
            let objGroup = {};
            if (obj.tags && obj.tags.length > 0) {
                for (let o of obj.tags) {
                    let g = await (group.findOneAsync({ project: objProject._id, name: o.name, type: 0 }));
                    if (g) {
                        g.remark = o.description ? o.description : "";
                        objGroup[o.name] = await (g.saveAsync());
                    } else {
                        objGroup[o.name] = await (group.createAsync({ id: uuid(), project: objProject._id, name: o.name, type: 0, remark: o.description ? o.description : "" }));
                    }
                }
            }

            // 同步接口
            let allowMethod = ["GET", "POST", "PUT", "DELETE", "PATCH"];
            for (let path in obj.paths) {
                let objInter;
                let request = obj.paths[path];
                for (let method in request) {
                    let interface = request[method];
                    if (allowMethod.indexOf(method.toUpperCase()) == -1) {
                        continue;
                    }

                    // 接口名称
                    let name;
                    if (interface.summary) {
                        name = interface.summary + ' ' + path
                    }
                    else if (interface.description) {
                        name = interface.description + ' ' + path
                    }
                    else {
                        name = path;
                    }

                    // 查询标签
                    let tagName = interface.tags ? interface.tags[0] : noName;
                    let g = await (group.findOneAsync({ project: objProject._id, name: tagName, type: 0 }));
                    if (g) {
                        objGroup[tagName] = await (g.saveAsync());
                    } else {
                        objGroup[tagName] = await (group.createAsync({ id: uuid(), project: objProject._id, name: tagName, type: 0, remark: "" }));
                    }

                    let update;
                    let hasInterface = { project: objProject._id, group: objGroup[tagName]._id, url: path, method: method.toUpperCase() }
                    let objInterface = await (req.interfaceModel.findOneAsync(hasInterface));
                    if (objInterface) {
                        update = {                                                                          // 修改
                            name: name,                                                                     // 名称
                            method: objInterface.method,                                                    // 路径
                            remark: interface.description ? interface.description : objInterface.remark,    // 简介
                            finish: interface.deprecated ? 2 : 1,                                           // 状态
                            param: [
                                {
                                    before: { mode: 0, code: "" },
                                    after: { mode: 0, code: "" },
                                    name: "",
                                    remark: "",
                                    id: uuid()
                                }
                            ],
                            $unset: { delete: 1 }
                        };
                    }
                    else {
                        update = {                                  // 修改
                            name: name,                             // 名称
                            project: objProject._id,                // 项目
                            group: objGroup[tagName]._id,           // 分组
                            method: method.toUpperCase(),           // 路径
                            url: path,                              // 路径
                            remark: interface.description,          // 简介
                            finish: interface.deprecated ? 2 : 1,   // 状态
                            owner: objProject._id,                  // NULL
                            editor: objProject._id,                 // NULL
                            param: [
                                {
                                    before: { mode: 0, code: "" },
                                    after: { mode: 0, code: "" },
                                    name: "",
                                    remark: "",
                                    id: uuid(),
                                    queryParam: [],
                                    header: [],
                                    restParam: [],
                                    outInfo: { "rawMock": "", "rawRemark": "", "type": 0 },
                                    outParam: [],
                                }
                            ],
                            id: uuid()
                        };
                    }


                    let query = [], header = [], body = [], rest = [];

                    let bodyInfo = {
                        type: 0,
                        rawType: 0,
                        rawTextRemark: "",
                        rawFileRemark: "",
                        rawText: "",
                        rawJSON: [{ name: "", must: 1, type: 0, remark: "", show: 1, mock: "", drag: 1 }],
                        rawJSONType: 0
                    };

                    let outInfo = {
                        type: 0,
                        rawRemark: "",
                        rawMock: "",
                        jsonType: 0
                    };

                    let contentType = interface.consumes ? interface.consumes[0] : null;
                    if (!contentType) {
                        if (interface.parameters) {
                            for (let obj of interface.parameters) {
                                if (obj.in == "body" && obj.schema) {
                                    contentType = "application/json";
                                    break;
                                }
                            }
                        }
                    }

                    if (contentType) {
                        header.push({ name: "Content-Type", value: contentType, remark: "" });
                        if (contentType == "application/json") {
                            bodyInfo = {
                                type: 1,
                                rawType: 2,
                                rawTextRemark: "",
                                rawFileRemark: "",
                                rawText: "",
                                rawJSON: [{ name: "", must: 1, type: 0, remark: "", show: 1, mock: "", drag: 1 }],
                                rawJSONType: 0
                            };
                        }
                    }

                    if (interface.parameters) {
                        for (let o of interface.parameters) {
                            if (o.in == "path") {
                                rest.push({
                                    value: { "status": "", "data": [{ value: o.example, remark: "" }], "type": 0 },
                                    name: o.name,
                                    remark: o.description ? o.description : ""
                                })
                            }
                            else if (o.in == "header") {
                                header.push({
                                    name: o.name,
                                    remark: o.description ? o.description : "",
                                    value: o.example ? o.example : ""
                                })
                            }
                            else if (o.in == "query") {
                                query.push({
                                    name: o.name,
                                    remark: o.description ? o.description : "",
                                    must: o.required ? 1 : 0,
                                    value: { "status": "", "data": [{ value: o.example, remark: "" }], "type": 0 }
                                })
                            }
                        }
                    }
                    if (interface.requestBody) {
                        // TODO
                        if (o.in == "body") {
                            if (bodyInfo.type == 0) {
                                body.push({
                                    name: o.name,
                                    type: 0,
                                    must: o.required ? 1 : 0,
                                    remark: o.description ? o.description : "",
                                    value: { "status": "", "data": [{ value: o.example, remark: "" }], "type": 0 }
                                });
                            }
                            else if (bodyInfo.type == 1 && bodyInfo.rawType == 2) {
                                let objBody = {
                                    mock: "",
                                    remark: o.description,
                                    type: 1,
                                    must: o.required ? 1 : 0,
                                    name: o.name
                                };
                                if (o.schema) {
                                    if (o.schema.$ref) {
                                        let key = o.schema.$ref.substr(14);
                                        if (objDef[key]) {
                                            let o1 = util.clone(objDef[key]);
                                            o1.remark = objBody.remark;
                                            o1.must = objBody.must;
                                            o1.name = objBody.name;
                                            objBody = o1;
                                            if (bodyInfo.rawJSON[0].name) {
                                                bodyInfo.rawJSON.push(objBody);
                                            }
                                            else {
                                                bodyInfo.rawJSON[0] = objBody;
                                            }
                                        }
                                    }
                                    else {
                                        if (o.schema.items) {
                                            objBody.data = [];
                                            objBody.type = 3;
                                            if (o.schema.items.$ref) {
                                                let key = o.schema.items.$ref.substr(14);
                                                if (objDef[key]) {
                                                    let o1 = util.clone(objDef[key]);
                                                    objBody.data.push(o1);
                                                    if (bodyInfo.rawJSON[0].name) {
                                                        bodyInfo.rawJSON.push(objBody);
                                                    }
                                                    else {
                                                        bodyInfo.rawJSON[0] = objBody;
                                                    }
                                                }
                                            }
                                            else {
                                                let type;
                                                let o1 = o.schema.items;
                                                if (o1.type == "string" || o1.type == "byte" || o1.type == "binary" || o1.type == "date" || o1.type == "dateTime" || o1.type == "password") {
                                                    type = 0;
                                                }
                                                else if (o1.type == "integer" || o1.type == "long" || o1.type == "float" || o1.type == "double") {
                                                    type = 1;
                                                }
                                                else if (o1.type == "boolean") {
                                                    type = 2;
                                                }
                                                let o2 = {
                                                    mock: o1.default !== undefined ? o1.default : "",
                                                    remark: o1.description ? o1.description : "",
                                                    type: type,
                                                    must: 1,
                                                    name: null
                                                }
                                                objBody.data.push(o2);
                                                if (bodyInfo.rawJSON[0].name) {
                                                    bodyInfo.rawJSON.push(objBody);
                                                }
                                                else {
                                                    bodyInfo.rawJSON[0] = objBody;
                                                }
                                            }
                                        }
                                        else if (o.schema.type == "cust" && o.schema.format == "json") {
                                            objBody.data = [];
                                            objBody.type = 3;
                                            let objJSON;
                                            try {
                                                objJSON = JSON.parse(o.schema.content);
                                            }
                                            catch (err) {
                                                continue;
                                            }
                                            let result = [];
                                            for (let key in objJSON) {
                                                util.handleResultData(key, objJSON[key], result, null, 1, 1)
                                            }
                                            objBody.data = result;
                                            if (bodyInfo.rawJSON[0].name) {
                                                bodyInfo.rawJSON.push(objBody);
                                            }
                                            else {
                                                bodyInfo.rawJSON[0] = objBody;
                                            }
                                        }
                                    }
                                }
                            }
                        }

                    }

                    // 参数组信息
                    if (interface.responses) {
                        if (Object.keys(interface.responses).length === 0) {
                            interface.responses['default'] = "";
                        }
                        let count = 0;
                        for (let status in interface.responses) {
                            count++;
                            let result = [];
                            let objRes = interface.responses[status];
                            if (objRes.schema && objRes.schema.$ref) {
                                let key = objRes.schema.$ref.substr(14);
                                if (objDef[key]) {
                                    let o1 = util.clone(objDef[key]);
                                    if (o1.type == 4) {
                                        result = o1.data;
                                    }
                                    else {
                                        outInfo.type = 1;
                                        outInfo.rawMock = o1.mock ? o1.mock : "";
                                        outInfo.rawRemark = objRes.description ? objRes.description : "";
                                    }
                                }
                            }
                            else if (objRes.schema && objRes.schema.items) {
                                outInfo.jsonType = 1;
                                result = [{ name: null, must: 1, type: 0, remark: "", mock: "", }]
                                if (objRes.schema.items.$ref) {
                                    let key = objRes.schema.items.$ref.substr(14);
                                    if (objDef[key]) {
                                        let o1 = util.clone(objDef[key]);
                                        if (o1.type == 4) {
                                            result[0].type = 4;
                                            result[0].data = o1.data;
                                        }
                                        else {
                                            for (let key in o1) {
                                                result[0][key] = o1[key];
                                            }
                                        }
                                    }
                                }
                                else {
                                    let type;
                                    let o1 = objRes.schema.items;
                                    if (o1.type == "string" || o1.type == "byte" || o1.type == "binary" || o1.type == "date" || o1.type == "dateTime" || o1.type == "password") {
                                        type = 0;
                                    }
                                    else if (o1.type == "integer" || o1.type == "long" || o1.type == "float" || o1.type == "double") {
                                        type = 1;
                                    }
                                    else if (o1.type == "boolean") {
                                        type = 2;
                                    }
                                    result[0].type = type;
                                }
                            }
                            else if (objRes.schema && objRes.schema.properties) {
                                function __handleRes(key, value, data) {
                                    let obj = {
                                        mock: value.example ? value.example : "",
                                        remark: value.description ? value.description : "",
                                        type: 0, must: 1, name: key ? key : null
                                    }
                                    if (value.type == "string" || value.type == "byte" || value.type == "binary" || value.type == "date" || value.type == "dateTime" || value.type == "password") {
                                        obj.type = 0;
                                    }
                                    else if (value.type == "integer" || value.type == "long" || value.type == "float" || value.type == "double") {
                                        obj.type = 1;
                                    }
                                    else if (value.type == "boolean") {
                                        obj.type = 2;
                                    }
                                    else if (value.type == "array") {
                                        obj.type = 3;
                                        obj.data = [];
                                        if (value.items.$ref) {
                                            let result = [{ name: null, must: 1, type: 0, remark: "", mock: "", }]
                                            let def = value.items.$ref.substr(value.items.$ref.lastIndexOf("/") + 1);
                                            if (objDef[def]) {
                                                let o1 = util.clone(objDef[def]);
                                                if (o1.type == 4) {
                                                    result[0].type = 4;
                                                    result[0].data = o1.data;
                                                }
                                                else {
                                                    for (let key in o1) {
                                                        result[0][key] = o1[key];
                                                    }
                                                }
                                                obj.data = result;
                                            }
                                        }
                                        else {
                                            let type;
                                            let o1 = value.items;
                                            arguments.callee(null, o1, obj.data);
                                        }
                                    }
                                    else if (value.type == "object") {
                                        obj.type = 4;
                                        obj.data = [];
                                        for (let k in value.properties) {
                                            arguments.callee(k, value.properties[k], obj.data);
                                        }
                                    }
                                    else if (value.$ref) {
                                        let ref = value.$ref.substr(value.$ref.lastIndexOf("/") + 1);
                                        if (objDef[ref]) {
                                            let o1 = util.clone(objDef[ref]);
                                            if (o1.type == 4) {
                                                obj.type = 4;
                                                obj.data = o1.data;
                                            }
                                            else {
                                                for (let key in o1) {
                                                    obj[key] = o1[key];
                                                }
                                            }
                                        }
                                    }
                                    data.push(obj);
                                }
                                for (let key in objRes.schema.properties) {
                                    __handleRes(key, objRes.schema.properties[key], result);
                                }
                            }
                            else if (objRes.schema && objRes.schema.type == "cust" && objRes.schema.format == "json") {
                                let objJSON;
                                try {
                                    objJSON = JSON.parse(objRes.schema.content);
                                }
                                catch (err) {

                                }
                                if (objJSON) {
                                    let result1 = [];
                                    for (let key in objJSON) {
                                        util.handleResultData(key, objJSON[key], result1, null, 1)
                                    }
                                    result = result1;
                                }
                            }
                            else {
                                outInfo.type = 1;
                                if (objRes.schema) {
                                    outInfo.rawRemark = objRes.description + "(" + (objRes.schema.type ? objRes.schema.type : "") + ")";
                                }
                                else {
                                    outInfo.rawRemark = ""
                                }
                            }

                            let objParam = {
                                id: uuid(),
                                name: objRes.description ? objRes.description : "参数",
                                remark: status && status != "default" ? "HTTP状态码:" + status : "",
                                before: { code: "", mode: 0 },
                                after: { code: "", mode: 0 }
                            };
                            objParam.queryParam = query;
                            objParam.header = header;
                            objParam.restParam = rest;
                            objParam.outParam = result;
                            objParam.outInfo = outInfo;
                            if (update.method == "POST" || update.method == "PUT" || update.method == "PATCH") {
                                objParam.bodyParam = body;
                                objParam.bodyInfo = bodyInfo;
                            }
                            if (count == 1) {
                                update.param[0] = util.clone(objParam)
                            }
                            else {
                                update.param.push(util.clone(objParam))
                            }
                        }
                    }

                    // 更新数据
                    if (objInterface) {
                        await (req.interfaceModel.findOneAndUpdateAsync({ _id: objInterface._id }, update))
                    }
                    else {
                        await (req.interfaceModel.createAsync(update));
                    }
                }
            }

            util.ok(res, "同步成功");
            return;


            let objDef = {};
            function handleDef(def, root, arrDef) {
                let ref = false, obj, key;
                if (def.$ref) {
                    ref = true;
                    key = def.$ref.substr(14);
                    if (objDef[key]) {
                        if (arrDef.indexOf(key) > -1) {
                            return null;
                        }
                        else {
                            return objDef[key];
                        }
                    }
                    else {
                        if (arrDef.indexOf(key) > -1) {
                            return null;
                        }
                        arrDef.push(key);
                        obj = root[key];
                    }
                }
                else {
                    obj = def;
                }
                if (!obj) {
                    return null;
                }
                let objRaw = {
                    mock: "",
                    remark: "",
                    type: 0,
                    must: 1,
                    name: null
                };
                if (obj.type == "string" || obj.type == "byte" || obj.type == "binary" || obj.type == "date" || obj.type == "dateTime" || obj.type == "password") {
                    objRaw.type = 0;
                }
                else if (obj.type == "integer" || obj.type == "long" || obj.type == "float" || obj.type == "double") {
                    objRaw.type = 1;
                }
                else if (obj.type == "boolean") {
                    objRaw.type = 2;
                }
                else if (obj.type == "array") {
                    objRaw.type = 3;
                    objRaw.data = [];
                    let index = arrDef.length;
                    let obj1 = arguments.callee(obj.items, root, arrDef);
                    arrDef.splice(index);
                    if (obj1 !== null) {
                        obj1 = util.clone(obj1);
                        objRaw.data.push(obj1);
                    }
                }
                else if (obj.type == "object" || obj.type === undefined) {
                    objRaw.type = 4;
                    objRaw.data = [];
                    for (let key in obj.properties) {
                        let index = arrDef.length;
                        let obj1 = arguments.callee(obj.properties[key], root, arrDef);
                        arrDef.splice(index);
                        if (obj1 !== null) {
                            obj1 = util.clone(obj1);
                            obj1.name = key;
                            objRaw.data.push(obj1);
                        }
                    }
                }
                if (obj.description) {
                    objRaw.remark = obj.description;
                }
                if (obj.default !== undefined) {
                    objRaw.mock = obj.default;
                }
                if (obj.example !== undefined || obj.enum !== undefined) {
                    objRaw.value = {
                        type: 0,
                        status: "",
                        data: []
                    };
                    if (obj.example !== undefined) {
                        objRaw.value.data.push({
                            value: obj.example,
                            remark: ""
                        })
                    }
                    if (obj.enum !== undefined) {
                        objRaw.value.data = objRaw.value.data.concat(obj.enum.map(function (obj) {
                            return {
                                value: obj,
                                remark: ""
                            }
                        }));
                    }
                }
                if (def.$ref) {
                    objDef[key] = objRaw;
                }
                return objRaw;
            }
            if (obj.definitions) {
                for (let key in obj.definitions) {
                    let val = obj.definitions[key];
                    let arrDef = [key];
                    let o = handleDef(val, obj.definitions, arrDef);
                    objDef[key] = o;
                }
            }



            util.ok(res, "同步成功");
        }
        catch (err) {
            util.catch(res, err);
        }
    }
}

module.exports = Sync
