import {QueryOptions, ResultFieldType, QueryAble} from "./queryAble";
import {FieldType} from "./pgDb";
import {PgDbLogger} from "./pgDbLogger";
import * as _ from 'lodash';

const util = require('util');
const NAMED_PARAMS_REGEXP = /(?:^|[^:]):(!?[a-zA-Z0-9_]+)/g;    // do not convert "::type cast"
const ASC_DESC_REGEXP = /^([^" (]+)( asc| desc)?$/;

export let pgUtils = {

    logError(logger:PgDbLogger, sql:string, queryParams:any, connection) {
        logger.error(sql, util.inspect(logger.paramSanitizer ? logger.paramSanitizer(queryParams) : queryParams, false, null), connection ? connection.processID : null);
    },

    quoteField(f) {
        return f.indexOf('"') == -1 && f.indexOf('(') == -1 ? '"' + f + '"' : f;
    },

    processQueryFields(options: QueryOptions): string {
        let s = options && options.distinct ? ' DISTINCT ' : ' ';
        if (options && options.fields) {
            if (Array.isArray(options.fields)) {
                return s + options.fields.map(pgUtils.quoteField).join(', ');
            } else {
                return s + options.fields;
            }
        } else {
            return s + ' *';
        }
    },

    /**
     * :named -> $1 (not works with DDL (schema, table, column))
     * :!named -> "value" (for DDL (schema, table, column))
     * do not touch ::type cast
     */
    processNamedParams(sql: string, params: Object) {
        let sql2 = [];
        let params2 = [];

        let p = NAMED_PARAMS_REGEXP.exec(sql);
        let lastIndex = 0;
        while (p) {
            let ddl = false;
            let name = p[1];
            if (name[0] == '!') {
                name = name.slice(1);
                ddl = true;
            }

            if (!(name in params)) {
                throw new Error(`No ${p[1]} in params (keys: ${Object.keys(params)})`);
            }
            sql2.push(sql.slice(lastIndex, NAMED_PARAMS_REGEXP.lastIndex - p[1].length - 1));

            if (ddl) {
                sql2.push('"' + ('' + params[name]).replace(/"/g, '""') + '"');
            } else {
                params2.push(params[name]);
                sql2.push('$' + params2.length);
            }
            lastIndex = NAMED_PARAMS_REGEXP.lastIndex;
            p = NAMED_PARAMS_REGEXP.exec(sql);
        }
        sql2.push(sql.substr(lastIndex));

        return {
            sql: sql2.join(''),
            params: params2
        }
    },

    processQueryOptions(options: QueryOptions): string {
        options = options || {};
        let sql = '';

        if (options.groupBy) {
            if (Array.isArray(options.groupBy)) {
                sql += ' GROUP BY ' + options.groupBy.map(pgUtils.quoteField).join(',');
            } else {
                sql += ' GROUP BY ' + pgUtils.quoteField(options.groupBy);
            }
        }
        if (options.orderBy) {
            if (typeof options.orderBy == 'string') {
                sql += ' ORDER BY ' + pgUtils.quoteField(options.orderBy);
            }
            else if (Array.isArray(options.orderBy)) {
                let orderBy = options.orderBy.map(v =>
                    v[0] == '+' ? pgUtils.quoteField(v.substr(1, v.length - 1)) + ' asc' :
                        v[0] == '-' ? pgUtils.quoteField(v.substr(1, v.length - 1)) + ' desc' :
                            v.replace(ASC_DESC_REGEXP, '"$1"$2'));
                sql += ' ORDER BY ' + orderBy.join(',');
            } else {
                let orderBy = [];
                _.forEach(options.orderBy, (v, k) => orderBy.push(pgUtils.quoteField(k) + ' ' + v));
                sql += ' ORDER BY ' + orderBy.join(',');
            }
        }
        if (options.limit) {
            sql += util.format(' LIMIT %d', options.limit);
        }
        if (options.offset) {
            sql += util.format(' OFFSET %d', options.offset);
        }
        if (options.forUpdate){
            sql += ' FOR UPDATE';
        }
        return sql;
    },

    /**
     * NOTE-DATE: there are 2 approaches to keep tz (the time correctly):
     *    1) use Date.toISOString() function, but then the $x placeholder should be TIMESTAMP WITH TIME ZONE $x
     *    2) use Date, and then no need to change the placeholder $x
     *    lets use 2)
     */
    transformInsertUpdateParams(param: any, fieldType: FieldType) {
        return (param != null && fieldType == FieldType.JSON) ? JSON.stringify(param) :
            (param != null && fieldType == FieldType.TIME && !(param instanceof Date)) ? new Date(param) : param;
    },

    postProcessResult(res: any[], fields: ResultFieldType[], pgdbTypeParsers: { [oid: number]: (string) => any }) {
        if (res) {
            if (res[0]) {
                let numberOfFields = 0;
                for (let f in res[0]) {
                    numberOfFields++;
                }
                if (numberOfFields != fields.length) {
                    throw Error("Name collision for the query, two or more fields have the same name.");
                }
            }
            pgUtils.convertTypes(res, fields, pgdbTypeParsers);
        }
    },

    convertTypes(res: any[], fields: ResultFieldType[], pgdbTypeParsers: { [oid: number]: (string) => any }) {
        for (let field of fields) {
            if (pgdbTypeParsers[field.dataTypeID]) {
                res.forEach(e => e[field.name] = e[field.name] == null ? null : pgdbTypeParsers[field.dataTypeID](e[field.name]));
            }
        }
    },

    createFunctionCaller(q: QueryAble, fn: { schema: string, name: string, return_single_row: boolean, return_single_value: boolean }) {
        return async (...args) => {
            let placeHolders = [];
            let params = [];
            args.forEach((arg) => {
                placeHolders.push('$' + (placeHolders.length + 1));
                params.push(arg);
            });
            let res = await q.query(`SELECT "${fn.schema}"."${fn.name}"(${placeHolders.join(',')})`, params);

            if (fn.return_single_value) {
                let keys = res[0] ? Object.keys(res[0]) : [];
                if (keys.length != 1) {
                    throw Error(`Return type error. schema: ${fn.schema} fn: ${fn.name} expected return type: single value, current value:` + JSON.stringify(res))
                }
                res = res.map((r) => r[keys[0]]);
            }
            if (fn.return_single_row) {
                if (res.length != 1) {
                    throw Error(`Return type error. schema: ${fn.schema} fn: ${fn.name} expected return type: single value, current value:` + JSON.stringify(res))
                }
                return res[0];
            } else {
                return res;
            }
        }
    }
};
