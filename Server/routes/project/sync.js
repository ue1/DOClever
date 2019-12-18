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
                return util.throw(e.commonError, "仅支持OpenAPI");
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
            let g = await (group.findOneAsync({ project: objProject._id, name: noName, type: 0 }));
            if (!g) {
                objGroup[noName] = await (group.createAsync({ id: uuid(), project: objProject._id, name: noName, type: 0, remark: "" }));
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
                    let query = { project: objProject._id, group: objGroup[tagName]._id, url: path, method: method.toUpperCase() }
                    let objInterface = await (req.interfaceModel.findOneAsync(query));
                    if (objInterface) {
                        update = {
                            name: name, // 名称
                            method: objInterface.method, // 路径
                            remark: interface.description ? interface.description : objInterface.remark, // 简介
                            param: [
                                {
                                    before: { mode: 0, code: "" },
                                    after: { mode: 0, code: "" },
                                    name: "未命名",
                                    remark: "",
                                    id: uuid()
                                }
                            ],
                            $unset: {
                                delete: 1
                            }
                        };
                    }
                    else {
                        update = {
                            name: name,
                            project: objProject._id,
                            group: objGroup[tagName]._id,
                            url: path,
                            remark: interface.description,
                            method: method.toUpperCase(),
                            owner: '',
                            editor: '',
                            param: [
                                {
                                    before: { mode: 0, code: "" },
                                    after: { mode: 0, code: "" },
                                    name: "未命名",
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


                    let rest = [], query = [], header = [], body = [];

                    let bodyInfo = {
                        type: 0,
                        rawType: 0,
                        rawTextRemark: "",
                        rawFileRemark: "",
                        rawText: "",
                        rawJSON: [{
                            name: "",
                            must: 1,
                            type: 0,
                            remark: "",
                            show: 1,
                            mock: "",
                            drag: 1
                        }],
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
                        header.push({
                            name: "Content-Type",
                            value: contentType,
                            remark: ""
                        });
                        if (contentType == "application/json") {
                            bodyInfo = {
                                type: 1,
                                rawType: 2,
                                rawTextRemark: "",
                                rawFileRemark: "",
                                rawText: "",
                                rawJSON: [{
                                    name: "",
                                    must: 1,
                                    type: 0,
                                    remark: "",
                                    show: 1,
                                    mock: "",
                                    drag: 1
                                }],
                                rawJSONType: 0
                            };
                        }
                    }
                    if (interface.parameters) {
                        for (let o of interface.parameters) {
                            if (o.in == "path") {
                                rest.push({
                                    value: {
                                        "status": "",
                                        "data": [],
                                        "type": 0
                                    },
                                    name: o.name,
                                    remark: o.description ? o.description : ""
                                })
                            }
                            else if (o.in == "query") {
                                query.push({
                                    name: o.name,
                                    remark: o.description ? o.description : "",
                                    must: o.required ? 1 : 0,
                                    value: {
                                        "status": "",
                                        "data": (o.items && o.items.enum) ? o.items.enum.map(function (obj) {
                                            return {
                                                value: obj.toString(),
                                                remark: ""
                                            }
                                        }) : (o.default ? [{
                                            value: o.default.toString(),
                                            remark: ""
                                        }] : []),
                                        "type": 0
                                    }
                                })
                            }
                            else if (o.in == "header") {
                                header.push({
                                    name: o.name,
                                    remark: o.description ? o.description : "",
                                    value: o.default ? o.default : ""
                                })
                            }
                            else if (o.in == "body") {
                                if (bodyInfo.type == 0) {
                                    let objBody = {
                                        name: o.name,
                                        type: 0,
                                        must: o.required ? 1 : 0,
                                        remark: o.description ? o.description : ""
                                    };
                                    body.push(objBody);
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
                            else if (o.in == "formData") {
                                let objBody = {
                                    name: o.name,
                                    type: o.type != "file" ? 0 : 1,
                                    must: o.required ? 1 : 0,
                                    remark: o.description ? o.description : ""
                                };
                                body.push(objBody);
                                header["Content-Type"] = "multipart/form-data";
                            }
                        }
                    }
                    if (interface.responses) {
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
                                result = [
                                    {
                                        name: null,
                                        must: 1,
                                        type: 0,
                                        remark: "",
                                        mock: "",
                                    }
                                ]
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
                                        type: 0,
                                        must: 1,
                                        name: key ? key : null
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
                                            let result = [
                                                {
                                                    name: null,
                                                    must: 1,
                                                    type: 0,
                                                    remark: "",
                                                    mock: "",
                                                }
                                            ]
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
                                name: status,
                                remark: objRes.description ? objRes.description : "",
                                id: uuid(),
                                before: {
                                    code: "",
                                    mode: 0
                                },
                                after: {
                                    code: "",
                                    mode: 0
                                }
                            };
                            objParam.restParam = rest;
                            objParam.queryParam = query;
                            objParam.header = header;
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

            // let objGroup = {};
            // let arr = [], objRemark = {};
            // if (obj.tags) {
            //     for (let o of obj.tags) {
            //         arr.push(o.name);
            //         objRemark[o.name] = o.description ? o.description : '';
            //     }
            // }
            // for (let key in obj.paths) {
            //     let objInter = obj.paths[key];
            //     for (let key1 in objInter) {
            //         let objIns = objInter[key1];
            //         if (objIns.tags) {
            //             objIns.tags.forEach(function (obj) {
            //                 if (arr.indexOf(obj) == -1) {
            //                     arr.push(obj);
            //                 }
            //             })
            //         }
            //     }
            // }
            // if (arr.length > 0) {
            //     for (let obj of arr) {
            //         objGroup[obj] = await (group.createAsync({
            //             name: obj,
            //             project: objProject._id,
            //             type: 0,
            //             id: uuid(),
            //             remark: objRemark[obj] ? objRemark[obj] : ""
            //         }));
            //     }
            // }
            // else {
            //     objGroup["未命名"] = await (group.createAsync({
            //         name: "未命名",
            //         project: objProject._id,
            //         type: 0,
            //         id: uuid(),
            //         remark: ""
            //     }));
            // }
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

            // let arrMethod = ["GET", "POST", "PUT", "DELETE", "PATCH"];
            // for (let path in obj.paths) {
            //     let objInter;
            //     let obj1 = obj.paths[path];
            //     for (let method in obj1) {
            //         let interRaw = obj1[method];
            //         if (arrMethod.indexOf(method.toUpperCase()) == -1) {
            //             continue;
            //         }
            //         let name;
            //         if (interRaw.summary) {
            //             name = interRaw.summary
            //         }
            //         else if (interRaw.description) {
            //             name = interRaw.description
            //         }
            //         else {
            //             name = path;
            //             let index = name.lastIndexOf("/");
            //             if (index > -1) {
            //                 name = name.substr(index + 1);
            //             }
            //         }
            //         let query1 = {
            //             project: objProject._id,
            //             group: objGroup[interRaw.tags[0]]._id,
            //             url: path,
            //             method: method.toUpperCase()
            //         }
            //         if (req.version) {
            //             query1.version = req.version._id;
            //         }
            //         objInter = await (req.interfaceModel.findOneAsync(query1));
            //         let update;
            //         if (objInter) {
            //             update = {
            //                 name: name,
            //                 method: objInter.method,
            //                 remark: interRaw.description ? interRaw.description : objInter.remark,
            //                 param: [
            //                     {
            //                         before: {
            //                             mode: 0,
            //                             code: ""
            //                         },
            //                         after: {
            //                             mode: 0,
            //                             code: ""
            //                         },
            //                         name: "未命名",
            //                         remark: "",
            //                         id: uuid()
            //                     }
            //                 ],
            //                 $unset: {
            //                     delete: 1
            //                 }
            //             };
            //         }
            //         else {
            //             update = {
            //                 name: name,
            //                 project: objProject._id,
            //                 group: (interRaw.tags && objGroup[interRaw.tags[0]]) ? objGroup[interRaw.tags[0]]._id : objGroup["未命名"]._id,
            //                 url: path,
            //                 remark: interRaw.description,
            //                 method: method.toUpperCase(),
            //                 owner: req.userInfo._id,
            //                 editor: req.userInfo._id,
            //                 param: [
            //                     {
            //                         before: {
            //                             mode: 0,
            //                             code: ""
            //                         },
            //                         after: {
            //                             mode: 0,
            //                             code: ""
            //                         },
            //                         name: "未命名",
            //                         remark: "",
            //                         id: uuid(),
            //                         queryParam: [],
            //                         header: [],
            //                         restParam: [],
            //                         outInfo: {
            //                             "rawMock": "",
            //                             "rawRemark": "",
            //                             "type": 0
            //                         },
            //                         outParam: [],
            //                     }
            //                 ],
            //                 id: uuid()
            //             };
            //         }
            //         let rest = [], query = [], header = [], body = [];
            //         let bodyInfo = {
            //             type: 0,
            //             rawType: 0,
            //             rawTextRemark: "",
            //             rawFileRemark: "",
            //             rawText: "",
            //             rawJSON: [{
            //                 name: "",
            //                 must: 1,
            //                 type: 0,
            //                 remark: "",
            //                 show: 1,
            //                 mock: "",
            //                 drag: 1
            //             }],
            //             rawJSONType: 0
            //         };
            //         let outInfo = {
            //             type: 0,
            //             rawRemark: "",
            //             rawMock: "",
            //             jsonType: 0
            //         };
            //         let contentType = interRaw.consumes ? interRaw.consumes[0] : null;
            //         if (!contentType) {
            //             if (interRaw.parameters) {
            //                 for (let obj of interRaw.parameters) {
            //                     if (obj.in == "body" && obj.schema) {
            //                         contentType = "application/json";
            //                         break;
            //                     }
            //                 }
            //             }
            //         }
            //         if (contentType) {
            //             header.push({
            //                 name: "Content-Type",
            //                 value: contentType,
            //                 remark: ""
            //             });
            //             if (contentType == "application/json") {
            //                 bodyInfo = {
            //                     type: 1,
            //                     rawType: 2,
            //                     rawTextRemark: "",
            //                     rawFileRemark: "",
            //                     rawText: "",
            //                     rawJSON: [{
            //                         name: "",
            //                         must: 1,
            //                         type: 0,
            //                         remark: "",
            //                         show: 1,
            //                         mock: "",
            //                         drag: 1
            //                     }],
            //                     rawJSONType: 0
            //                 };
            //             }
            //         }
            //         if (interRaw.parameters) {
            //             for (let o of interRaw.parameters) {
            //                 if (o.in == "path") {
            //                     rest.push({
            //                         value: {
            //                             "status": "",
            //                             "data": [],
            //                             "type": 0
            //                         },
            //                         name: o.name,
            //                         remark: o.description ? o.description : ""
            //                     })
            //                 }
            //                 else if (o.in == "query") {
            //                     query.push({
            //                         name: o.name,
            //                         remark: o.description ? o.description : "",
            //                         must: o.required ? 1 : 0,
            //                         value: {
            //                             "status": "",
            //                             "data": (o.items && o.items.enum) ? o.items.enum.map(function (obj) {
            //                                 return {
            //                                     value: obj.toString(),
            //                                     remark: ""
            //                                 }
            //                             }) : (o.default ? [{
            //                                 value: o.default.toString(),
            //                                 remark: ""
            //                             }] : []),
            //                             "type": 0
            //                         }
            //                     })
            //                 }
            //                 else if (o.in == "header") {
            //                     header.push({
            //                         name: o.name,
            //                         remark: o.description ? o.description : "",
            //                         value: o.default ? o.default : ""
            //                     })
            //                 }
            //                 else if (o.in == "body") {
            //                     if (bodyInfo.type == 0) {
            //                         let objBody = {
            //                             name: o.name,
            //                             type: 0,
            //                             must: o.required ? 1 : 0,
            //                             remark: o.description ? o.description : ""
            //                         };
            //                         body.push(objBody);
            //                     }
            //                     else if (bodyInfo.type == 1 && bodyInfo.rawType == 2) {
            //                         let objBody = {
            //                             mock: "",
            //                             remark: o.description,
            //                             type: 1,
            //                             must: o.required ? 1 : 0,
            //                             name: o.name
            //                         };
            //                         if (o.schema) {
            //                             if (o.schema.$ref) {
            //                                 let key = o.schema.$ref.substr(14);
            //                                 if (objDef[key]) {
            //                                     let o1 = util.clone(objDef[key]);
            //                                     o1.remark = objBody.remark;
            //                                     o1.must = objBody.must;
            //                                     o1.name = objBody.name;
            //                                     objBody = o1;
            //                                     if (bodyInfo.rawJSON[0].name) {
            //                                         bodyInfo.rawJSON.push(objBody);
            //                                     }
            //                                     else {
            //                                         bodyInfo.rawJSON[0] = objBody;
            //                                     }
            //                                 }
            //                             }
            //                             else {
            //                                 if (o.schema.items) {
            //                                     objBody.data = [];
            //                                     objBody.type = 3;
            //                                     if (o.schema.items.$ref) {
            //                                         let key = o.schema.items.$ref.substr(14);
            //                                         if (objDef[key]) {
            //                                             let o1 = util.clone(objDef[key]);
            //                                             objBody.data.push(o1);
            //                                             if (bodyInfo.rawJSON[0].name) {
            //                                                 bodyInfo.rawJSON.push(objBody);
            //                                             }
            //                                             else {
            //                                                 bodyInfo.rawJSON[0] = objBody;
            //                                             }
            //                                         }
            //                                     }
            //                                     else {
            //                                         let type;
            //                                         let o1 = o.schema.items;
            //                                         if (o1.type == "string" || o1.type == "byte" || o1.type == "binary" || o1.type == "date" || o1.type == "dateTime" || o1.type == "password") {
            //                                             type = 0;
            //                                         }
            //                                         else if (o1.type == "integer" || o1.type == "long" || o1.type == "float" || o1.type == "double") {
            //                                             type = 1;
            //                                         }
            //                                         else if (o1.type == "boolean") {
            //                                             type = 2;
            //                                         }
            //                                         let o2 = {
            //                                             mock: o1.default !== undefined ? o1.default : "",
            //                                             remark: o1.description ? o1.description : "",
            //                                             type: type,
            //                                             must: 1,
            //                                             name: null
            //                                         }
            //                                         objBody.data.push(o2);
            //                                         if (bodyInfo.rawJSON[0].name) {
            //                                             bodyInfo.rawJSON.push(objBody);
            //                                         }
            //                                         else {
            //                                             bodyInfo.rawJSON[0] = objBody;
            //                                         }
            //                                     }
            //                                 }
            //                                 else if (o.schema.type == "cust" && o.schema.format == "json") {
            //                                     objBody.data = [];
            //                                     objBody.type = 3;
            //                                     let objJSON;
            //                                     try {
            //                                         objJSON = JSON.parse(o.schema.content);
            //                                     }
            //                                     catch (err) {
            //                                         continue;
            //                                     }
            //                                     let result = [];
            //                                     for (let key in objJSON) {
            //                                         util.handleResultData(key, objJSON[key], result, null, 1, 1)
            //                                     }
            //                                     objBody.data = result;
            //                                     if (bodyInfo.rawJSON[0].name) {
            //                                         bodyInfo.rawJSON.push(objBody);
            //                                     }
            //                                     else {
            //                                         bodyInfo.rawJSON[0] = objBody;
            //                                     }
            //                                 }
            //                             }
            //                         }
            //                     }
            //                 }
            //                 else if (o.in == "formData") {
            //                     let objBody = {
            //                         name: o.name,
            //                         type: o.type != "file" ? 0 : 1,
            //                         must: o.required ? 1 : 0,
            //                         remark: o.description ? o.description : ""
            //                     };
            //                     body.push(objBody);
            //                     header["Content-Type"] = "multipart/form-data";
            //                 }
            //             }
            //         }
            //         if (interRaw.responses) {
            //             let count = 0;
            //             for (let status in interRaw.responses) {
            //                 count++;
            //                 let result = [];
            //                 let objRes = interRaw.responses[status];
            //                 if (objRes.schema && objRes.schema.$ref) {
            //                     let key = objRes.schema.$ref.substr(14);
            //                     if (objDef[key]) {
            //                         let o1 = util.clone(objDef[key]);
            //                         if (o1.type == 4) {
            //                             result = o1.data;
            //                         }
            //                         else {
            //                             outInfo.type = 1;
            //                             outInfo.rawMock = o1.mock ? o1.mock : "";
            //                             outInfo.rawRemark = objRes.description ? objRes.description : "";
            //                         }
            //                     }
            //                 }
            //                 else if (objRes.schema && objRes.schema.items) {
            //                     outInfo.jsonType = 1;
            //                     result = [
            //                         {
            //                             name: null,
            //                             must: 1,
            //                             type: 0,
            //                             remark: "",
            //                             mock: "",
            //                         }
            //                     ]
            //                     if (objRes.schema.items.$ref) {
            //                         let key = objRes.schema.items.$ref.substr(14);
            //                         if (objDef[key]) {
            //                             let o1 = util.clone(objDef[key]);
            //                             if (o1.type == 4) {
            //                                 result[0].type = 4;
            //                                 result[0].data = o1.data;
            //                             }
            //                             else {
            //                                 for (let key in o1) {
            //                                     result[0][key] = o1[key];
            //                                 }
            //                             }
            //                         }
            //                     }
            //                     else {
            //                         let type;
            //                         let o1 = objRes.schema.items;
            //                         if (o1.type == "string" || o1.type == "byte" || o1.type == "binary" || o1.type == "date" || o1.type == "dateTime" || o1.type == "password") {
            //                             type = 0;
            //                         }
            //                         else if (o1.type == "integer" || o1.type == "long" || o1.type == "float" || o1.type == "double") {
            //                             type = 1;
            //                         }
            //                         else if (o1.type == "boolean") {
            //                             type = 2;
            //                         }
            //                         result[0].type = type;
            //                     }
            //                 }
            //                 else if (objRes.schema && objRes.schema.properties) {
            //                     function __handleRes(key, value, data) {
            //                         let obj = {
            //                             mock: value.example ? value.example : "",
            //                             remark: value.description ? value.description : "",
            //                             type: 0,
            //                             must: 1,
            //                             name: key ? key : null
            //                         }
            //                         if (value.type == "string" || value.type == "byte" || value.type == "binary" || value.type == "date" || value.type == "dateTime" || value.type == "password") {
            //                             obj.type = 0;
            //                         }
            //                         else if (value.type == "integer" || value.type == "long" || value.type == "float" || value.type == "double") {
            //                             obj.type = 1;
            //                         }
            //                         else if (value.type == "boolean") {
            //                             obj.type = 2;
            //                         }
            //                         else if (value.type == "array") {
            //                             obj.type = 3;
            //                             obj.data = [];
            //                             if (value.items.$ref) {
            //                                 let result = [
            //                                     {
            //                                         name: null,
            //                                         must: 1,
            //                                         type: 0,
            //                                         remark: "",
            //                                         mock: "",
            //                                     }
            //                                 ]
            //                                 let def = value.items.$ref.substr(value.items.$ref.lastIndexOf("/") + 1);
            //                                 if (objDef[def]) {
            //                                     let o1 = util.clone(objDef[def]);
            //                                     if (o1.type == 4) {
            //                                         result[0].type = 4;
            //                                         result[0].data = o1.data;
            //                                     }
            //                                     else {
            //                                         for (let key in o1) {
            //                                             result[0][key] = o1[key];
            //                                         }
            //                                     }
            //                                     obj.data = result;
            //                                 }
            //                             }
            //                             else {
            //                                 let type;
            //                                 let o1 = value.items;
            //                                 arguments.callee(null, o1, obj.data);
            //                             }
            //                         }
            //                         else if (value.type == "object") {
            //                             obj.type = 4;
            //                             obj.data = [];
            //                             for (let k in value.properties) {
            //                                 arguments.callee(k, value.properties[k], obj.data);
            //                             }
            //                         }
            //                         else if (value.$ref) {
            //                             let ref = value.$ref.substr(value.$ref.lastIndexOf("/") + 1);
            //                             if (objDef[ref]) {
            //                                 let o1 = util.clone(objDef[ref]);
            //                                 if (o1.type == 4) {
            //                                     obj.type = 4;
            //                                     obj.data = o1.data;
            //                                 }
            //                                 else {
            //                                     for (let key in o1) {
            //                                         obj[key] = o1[key];
            //                                     }
            //                                 }
            //                             }
            //                         }
            //                         data.push(obj);
            //                     }
            //                     for (let key in objRes.schema.properties) {
            //                         __handleRes(key, objRes.schema.properties[key], result);
            //                     }
            //                 }
            //                 else if (objRes.schema && objRes.schema.type == "cust" && objRes.schema.format == "json") {
            //                     let objJSON;
            //                     try {
            //                         objJSON = JSON.parse(objRes.schema.content);
            //                     }
            //                     catch (err) {

            //                     }
            //                     if (objJSON) {
            //                         let result1 = [];
            //                         for (let key in objJSON) {
            //                             util.handleResultData(key, objJSON[key], result1, null, 1)
            //                         }
            //                         result = result1;
            //                     }
            //                 }
            //                 else {
            //                     outInfo.type = 1;
            //                     if (objRes.schema) {
            //                         outInfo.rawRemark = objRes.description + "(" + (objRes.schema.type ? objRes.schema.type : "") + ")";
            //                     }
            //                     else {
            //                         outInfo.rawRemark = ""
            //                     }
            //                 }
            //                 let objParam = {
            //                     name: status,
            //                     remark: objRes.description ? objRes.description : "",
            //                     id: uuid(),
            //                     before: {
            //                         code: "",
            //                         mode: 0
            //                     },
            //                     after: {
            //                         code: "",
            //                         mode: 0
            //                     }
            //                 };
            //                 objParam.restParam = rest;
            //                 objParam.queryParam = query;
            //                 objParam.header = header;
            //                 objParam.outParam = result;
            //                 objParam.outInfo = outInfo;
            //                 if (update.method == "POST" || update.method == "PUT" || update.method == "PATCH") {
            //                     objParam.bodyParam = body;
            //                     objParam.bodyInfo = bodyInfo;
            //                 }
            //                 if (count == 1) {
            //                     update.param[0] = util.clone(objParam)
            //                 }
            //                 else {
            //                     update.param.push(util.clone(objParam))
            //                 }
            //             }
            //         }
            //         if (objInter) {
            //             await (req.interfaceModel.findOneAndUpdateAsync({
            //                 _id: objInter._id
            //             }, update))
            //         }
            //         else {
            //             await (req.interfaceModel.createAsync(update));
            //         }
            //     }
            // }
            util.ok(res, "同步成功");
        }
        catch (err) {
            util.catch(res, err);
        }
    }
}

module.exports = Sync
