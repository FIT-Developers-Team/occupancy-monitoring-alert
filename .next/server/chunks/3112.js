exports.id=3112,exports.ids=[3112],exports.modules={8216:(a,b,c)=>{"use strict";c.d(b,{BC:()=>q,Ld:()=>x,XK:()=>w,dU:()=>r,kE:()=>v});var d=c(51247),e=c.n(d),f=c(33873),g=c.n(f),h=c(29021),i=c.n(h);let j=process.env.DUCKDB_HISTORY_PATH||g().join(process.cwd(),"db","warehouse_history.duckdb"),k=process.env.DUCKDB_STATE_PATH||g().join(process.cwd(),"db","app_state.duckdb");function l(a){if("bigint"==typeof a)return Number(a);if(a instanceof Date)return a.toISOString();if(Array.isArray(a))return a.map(l);if(a&&"object"==typeof a){let b={};for(let[c,d]of Object.entries(a))b[c]=l(d);return b}return a}function m(a,b,c){return new Promise((d,e)=>{a.all(b,...c,(a,b)=>a?e(a):d(b))})}function n(a,b){return new Promise((c,d)=>{let f,g=a=>a?d(a):c(f);f=void 0===b?new(e()).Database(a,g):new(e()).Database(a,b,g)})}let o=a=>new Promise(b=>setTimeout(b,a)),p=a=>/(lock|locked|busy|conflict|another process|cannot open file)/i.test(a instanceof Error?a.message:String(a));function q(){return i().existsSync(j)}async function r(a,b=[]){let c;if(!q())throw Error(`Database history tidak ditemukan di ${j}. Jalankan "npm run seed" (demo) atau sync Superset terlebih dahulu.`);for(let d=1;d<=4;d++){let f=null,g=!1;try{return f=await n(j,e().OPEN_READONLY),(await m(f,a,b)).map(l)}catch(a){if(c=a,!(g=d<4&&p(a)))throw a}finally{f&&await function(a){return new Promise(b=>a.close(()=>b()))}(f)}g&&await o(250*d)}throw c}let s=`
CREATE TABLE IF NOT EXISTS alerts (
  alert_id VARCHAR PRIMARY KEY,
  created_at TIMESTAMP, updated_at TIMESTAMP,
  rule_id VARCHAR, rule_name VARCHAR, severity VARCHAR,
  warehouse_code VARCHAR, zone VARCHAR, sloc_code VARCHAR, sku VARCHAR,
  title VARCHAR, detail VARCHAR,
  status VARCHAR, dedup_key VARCHAR, occurrences INTEGER DEFAULT 1,
  acknowledged_by VARCHAR, acknowledged_at TIMESTAMP,
  resolved_by VARCHAR, resolved_at TIMESTAMP, resolution_note VARCHAR,
  escalation_level INTEGER DEFAULT 1, next_escalation_at TIMESTAMP
);
CREATE TABLE IF NOT EXISTS alert_events (
  id VARCHAR PRIMARY KEY, alert_id VARCHAR, "at" TIMESTAMP,
  actor VARCHAR, action VARCHAR, note VARCHAR
);
CREATE TABLE IF NOT EXISTS audit_log (
  id VARCHAR PRIMARY KEY, "at" TIMESTAMP, actor VARCHAR, action VARCHAR,
  entity VARCHAR, before_json VARCHAR, after_json VARCHAR
);
CREATE TABLE IF NOT EXISTS notification_log (
  id VARCHAR PRIMARY KEY, alert_id VARCHAR, channel VARCHAR, recipient VARCHAR,
  "at" TIMESTAMP, status VARCHAR, message VARCHAR
);
CREATE TABLE IF NOT EXISTS rule_state (
  key VARCHAR PRIMARY KEY, state VARCHAR, value VARCHAR, updated_at TIMESTAMP
);
`,t=globalThis;async function u(){t.__wiomStateOpen||(i().mkdirSync(g().dirname(k),{recursive:!0}),t.__wiomStateOpen=n(k).catch(a=>{throw t.__wiomStateOpen=void 0,a}));let a=await t.__wiomStateOpen;return t.__wiomStateInit||(t.__wiomStateInit=new Promise((b,c)=>{a.exec(s,a=>a?c(a):b())}).catch(a=>{throw t.__wiomStateInit=void 0,a})),await t.__wiomStateInit,a}async function v(a,b=[]){let c=await u();return(await m(c,a,b)).map(l)}async function w(a,b=[]){let c=await u();await m(c,a,b)}function x(a=""){return a+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,8)}},55900:(a,b,c)=>{"use strict";c.d(b,{I9:()=>ad,p3:()=>X,YA:()=>T,cT:()=>S,Cj:()=>$,V0:()=>_,z5:()=>P,qp:()=>ab,B5:()=>Y,V9:()=>G,Eo:()=>aa,o8:()=>M,hk:()=>O,AS:()=>N,gH:()=>U,Nt:()=>R,C$:()=>E,Nw:()=>ac});var d=c(8216),e=c(69988);function f(a,b){let c=(0,e.sx)(b);return a>=c.breach?"BREACH":a>=c.critical?"CRITICAL":a>=c.warning?"WARNING":a>=c.monitor?"MONITOR":"NORMAL"}function g(a,b=12){let c=[...a].sort((a,b)=>new Date(a.t).getTime()-new Date(b.t).getTime()).slice(-(b+1));if(c.length<3)return 0;let d=[];for(let a=1;a<c.length;a++){let b=(new Date(c[a].t).getTime()-new Date(c[a-1].t).getTime())/36e5;b<=0||d.push((c[a].pct-c[a-1].pct)/b)}if(!d.length)return 0;let e=0,f=0;return d.forEach((a,b)=>{let c=b+1;e+=a*c,f+=c}),e/f}function h(a,b,c){return a>=c?0:b<.02?null:(c-a)/b}function i(a,b){return b?(!a.wh||a.wh===b.wh)&&(!a.zone||a.zone===b.zone||a.zone===b.rack_zone)&&(!a.rack_zone||a.rack_zone===b.rack_zone)&&(!a.aisle||a.aisle===b.aisle)&&(!a.bay||a.bay===b.bay)&&(!a.level||a.level===b.level)&&(!a.bin||a.bin===b.bin)&&(!a.storage||a.storage===b.storage)&&!0:!a.wh&&!a.zone&&!a.rack_zone&&!a.aisle&&!a.bay&&!a.level&&!a.bin&&!a.storage}function j(a){let b=(0,e.lD)(),c=b.basis_default,d=b.utilization_pct,f=a.max_quantity,g=a.max_volume,h=!1,j=!1;for(let e of b.rules){var k;k=e.scope,!k.l1_category&&i(k,a)&&(e.set.basis&&(c=e.set.basis),void 0!==e.set.utilization_pct&&(d=e.set.utilization_pct),void 0!==e.set.max_qty&&(f=e.set.max_qty,h=!0),void 0!==e.set.max_cbm&&(g=e.set.max_cbm,j=!0))}return{basis:c,cap_qty:Math.max(0,f),cap_cbm:d/100*Math.max(0,g),utilization_pct:d,qty_valid:h||a.max_quantity>1,cbm_valid:j||a.max_volume>1}}function k(a,b){let c=(0,e.lD)(),d=!c.exclude_categories.includes(a);for(let e of c.rules)e.scope.l1_category===a&&void 0!==e.set.count&&i(e.scope,b)&&(d=e.set.count);return d}let l=a=>Math.round(10*a)/10,m=a=>Math.round(1e3*a)/1e3;function n(a){return{wh:a.wh,zone:a.zone,rack_zone:a.rack_zone,aisle:a.aisle,bay:a.bay,level:a.level,bin:a.bin,storage:a.storage,max_quantity:a.max_quantity,max_volume:a.max_volume}}let o=()=>`WITH ${(0,e.c1)()}`,p="JOIN wh_map m ON m.location_id = v.location_id",q=`v.active
  AND nullif(trim(v.sloc_code), '') IS NOT NULL`,r=`${q}
  AND nullif(trim(v.zone), '') IS NOT NULL`;function s(a){let b=new Set((0,e.Zz)().warehouses.map(a=>a.code)),c=a.wh?.trim().toUpperCase();return{wh:c&&b.has(c)?c:void 0,zone:a.zone?.trim().toUpperCase()||void 0,sloc:a.sloc?.trim().toUpperCase()||void 0,operational:!!a.operational}}function t(a,b){let c=[];return a.wh&&(c.push("m.wh = ?"),b.push(a.wh)),a.zone&&(c.push("v.zone = ?"),b.push(a.zone)),a.sloc&&(c.push("v.sloc_code = ?"),b.push(a.sloc)),c.length?` AND ${c.join(" AND ")}`:""}function u(a){return a.operational||a.zone?r:q}function v(a){return a.map(a=>`'${a.replace(/'/g,"''")}'`).join(",")}let w=a=>`'${a.replace(/'/g,"''")}'`;function x(a="v",b="m"){let c=(0,e.lD)(),d=w(c.basis_default),f=String(c.utilization_pct),g=`coalesce(${a}.max_quantity, 0)`,h=`coalesce(${a}.max_volume, 0)`,i="FALSE",j="FALSE";for(let e of c.rules){if(e.scope.l1_category)continue;let c=function(a,b="v",c="m"){let d=[a.wh?`${c}.wh = ${w(a.wh)}`:"",a.zone?`(${b}.zone = ${w(a.zone)} OR ${b}.rack_zone = ${w(a.zone)})`:"",a.rack_zone?`${b}.rack_zone = ${w(a.rack_zone)}`:"",a.aisle?`${b}.aisle = ${w(a.aisle)}`:"",a.bay?`${b}.bay = ${w(a.bay)}`:"",a.level?`${b}.level = ${w(a.level)}`:"",a.bin?`${b}.bin = ${w(a.bin)}`:"",a.storage?`${b}.storage_handling = ${w(a.storage)}`:""].filter(Boolean);return d.length?d.join(" AND "):"TRUE"}(e.scope,a,b);e.set.basis&&(d=`(CASE WHEN ${c} THEN ${w(e.set.basis)} ELSE ${d} END)`),void 0!==e.set.utilization_pct&&(f=`(CASE WHEN ${c} THEN ${Number(e.set.utilization_pct)} ELSE ${f} END)`),void 0!==e.set.max_qty&&(g=`(CASE WHEN ${c} THEN ${Number(e.set.max_qty)} ELSE ${g} END)`,i=`(${i} OR (${c}))`),void 0!==e.set.max_cbm&&(h=`(CASE WHEN ${c} THEN ${Number(e.set.max_cbm)} ELSE ${h} END)`,j=`(${j} OR (${c}))`)}return{basis:d,capQty:`greatest(0, ${g})`,capCbm:`greatest(0, ${h}) * (${f} / 100.0)`,qtyValid:`(${i} OR coalesce(${a}.max_quantity, 0) > 1)`,cbmValid:`(${j} OR coalesce(${a}.max_volume, 0) > 1)`}}function y(a,b="v",c="m"){let d=(0,e.lD)(),f=new Set(d.exclude_categories),g=f.size?`coalesce(${a}, '') NOT IN (${v([...f])})`:"TRUE";for(let e of d.rules){if(!e.scope.l1_category||void 0===e.set.count)continue;let d=[`coalesce(${a}, '') = '${e.scope.l1_category.replace(/'/g,"''")}'`,e.scope.wh?`${c}.wh = '${e.scope.wh.replace(/'/g,"''")}'`:"",e.scope.zone?`(${b}.zone = '${e.scope.zone.replace(/'/g,"''")}' OR ${b}.rack_zone = '${e.scope.zone.replace(/'/g,"''")}')`:"",e.scope.rack_zone?`${b}.rack_zone = '${e.scope.rack_zone.replace(/'/g,"''")}'`:"",e.scope.aisle?`${b}.aisle = '${e.scope.aisle.replace(/'/g,"''")}'`:"",e.scope.bay?`${b}.bay = '${e.scope.bay.replace(/'/g,"''")}'`:"",e.scope.level?`${b}.level = '${e.scope.level.replace(/'/g,"''")}'`:"",e.scope.bin?`${b}.bin = '${e.scope.bin.replace(/'/g,"''")}'`:"",e.scope.storage?`${b}.storage_handling = '${e.scope.storage.replace(/'/g,"''")}'`:""].filter(Boolean).join(" AND ");g=`(CASE WHEN ${d} THEN ${e.set.count?"TRUE":"FALSE"} ELSE ${g} END)`}return g}let z=a=>`${a} IN (${v([...new Set((0,e.lD)().count_statuses)])})`,A=new Map,B=new Map,C=new Map;function D(a,b,c,d){for(a.delete(b),a.set(b,c);a.size>d;){let b=a.keys().next().value;if(void 0===b)break;a.delete(b)}}function E(){A.clear(),B.clear(),C.clear(),Q.clear(),H=null}async function F(a){let b=[];return(0,d.dU)(`${o()}
     SELECT v.sloc_id, v.sloc_code, m.wh, v.zone, v.rack_zone, v.aisle, v.bay, v.level, v.bin,
            v.storage_handling AS storage, v.max_quantity, v.max_volume, v.location_id
     FROM vw_sloc v ${p}
     WHERE ${u(a)}${t(a,b)}`,b)}async function G(a={}){let b=s(a);if(a.wh&&!b.wh)return[];let c=`${b.wh??"*"}|${b.zone??"*"}|${b.sloc??"*"}|${b.operational||b.zone?"operational":"active"}`,e=A.get(c);if(e&&Date.now()-e.at<2e4)return e.rows;let g=await F(b),h=[],i=await (0,d.dU)(`${o()}
     SELECT s.location_id, s.sloc_code, coalesce(s.l1_category,'') AS l1,
            sum(s.stock_qty)::DOUBLE AS qty, sum(s.occupied_cbm)::DOUBLE AS cbm,
            count(DISTINCT s.product_id)::INT AS pc
     FROM vw_stock_latest s
     JOIN vw_sloc v ON v.location_id = s.location_id AND v.sloc_code = s.sloc_code ${p}
     WHERE ${u(b)} AND ${z("s.status")}${t(b,h)}
     GROUP BY 1, 2, 3`,h),q=(a,b)=>`${a}|${b}`,r=new Map,v=new Map(g.map(a=>[q(a.location_id,a.sloc_code),a]));for(let a of i){let b=q(a.location_id,a.sloc_code),c=v.get(b);if(!c||!k(a.l1,n(c)))continue;let d=r.get(b)??{qty:0,cbm:0,pc:0};d.qty+=a.qty,d.cbm+=a.cbm,d.pc+=a.pc,r.set(b,d)}let w=g.map(a=>{let b=j(n(a)),c=r.get(q(a.location_id,a.sloc_code))??{qty:0,cbm:0,pc:0},d=b.qty_valid&&b.cap_qty>0?c.qty/b.cap_qty*100:null,e=b.cbm_valid&&b.cap_cbm>0?c.cbm/b.cap_cbm*100:null,g=("qty"===b.basis?d:e)??("qty"===b.basis?e:d)??0,h=c.qty>0||c.cbm>0;return{sloc_id:a.sloc_id,sloc_code:a.sloc_code,wh:a.wh,zone:a.zone,rack_zone:a.rack_zone,aisle:a.aisle,bay:a.bay,level:a.level,bin:a.bin,storage:a.storage,basis:b.basis,occ_qty:l(c.qty),cap_qty:l(b.cap_qty),occ_cbm:m(c.cbm),cap_cbm:m(b.cap_cbm),qty_valid:b.qty_valid,cbm_valid:b.cbm_valid,pct_qty:null===d?null:l(d),pct_cbm:null===e?null:l(e),occupied:h,pct_bin:100*!!h,pct:l(g),status:f(g,a.wh),status_qty:null===d?null:f(d,a.wh),status_cbm:null===e?null:f(e,a.wh),status_bin:"NORMAL",product_count:c.pc}});return D(A,c,{at:Date.now(),rows:w},10),w}let H=null,I=null;async function J(){return H&&Date.now()-H.at<6e4?H.rows:I||(I=(async()=>{let a=x(),b=await (0,d.dU)(`${o()}, effective AS (
         SELECT v.sloc_id, v.location_id, v.sloc_code, m.wh,
                coalesce(v.zone, '') AS zone, coalesce(v.rack_zone, '') AS rack_zone,
                coalesce(v.aisle, '') AS aisle, coalesce(v.bay, '') AS bay,
                coalesce(v.level, '') AS level, coalesce(v.bin, '') AS bin,
                coalesce(v.storage_handling, '') AS storage_handling,
                ${a.basis} AS basis, ${a.capQty} AS cap_qty, ${a.capCbm} AS cap_cbm,
                ${a.qtyValid} AS qty_valid, ${a.cbmValid} AS cbm_valid
         FROM vw_sloc v ${p}
         WHERE ${q}
       ), capacities AS (
         SELECT wh,
                sum(CASE WHEN qty_valid THEN cap_qty ELSE 0 END)::DOUBLE AS cap_qty,
                sum(CASE WHEN cbm_valid THEN cap_cbm ELSE 0 END)::DOUBLE AS cap_cbm,
                sum(CASE WHEN basis = 'cbm' THEN 1 ELSE 0 END)::INT AS n_cbm,
                count(*)::INT AS total
         FROM effective GROUP BY wh
       ), stock AS (
         SELECT e.wh,
                coalesce(sum(CASE WHEN e.qty_valid THEN s.stock_qty ELSE 0 END), 0)::DOUBLE AS qty,
                coalesce(sum(CASE WHEN e.cbm_valid THEN s.occupied_cbm ELSE 0 END), 0)::DOUBLE AS cbm
         FROM effective e
         JOIN vw_stock_latest s
           ON s.location_id = e.location_id AND s.sloc_code = e.sloc_code
         WHERE ${z("s.status")}
           AND ${y("s.l1_category","e","e")}
         GROUP BY e.wh
       ), filled AS (
         SELECT e.wh,
                count(DISTINCT CASE
                  WHEN s.stock_qty > 0 OR s.occupied_cbm > 0 THEN e.sloc_id
                END)::INT AS filled
         FROM effective e
         JOIN vw_stock_latest s
           ON s.location_id = e.location_id AND s.sloc_code = e.sloc_code
         WHERE ${z("s.status")}
           AND ${y("s.l1_category","e","e")}
         GROUP BY e.wh
       )
       SELECT c.wh, c.cap_qty, c.cap_cbm, c.n_cbm, c.total,
              coalesce(s.qty, 0)::DOUBLE AS qty, coalesce(s.cbm, 0)::DOUBLE AS cbm,
              coalesce(f.filled, 0)::INT AS filled
       FROM capacities c
       LEFT JOIN stock s USING (wh)
       LEFT JOIN filled f USING (wh)
       ORDER BY c.wh`),c=(0,e.$$)(),g=new Map((0,e.Zz)().warehouses.map(a=>[a.code,a.location_id])),h=b.map(a=>{let b=a.n_cbm>a.total/2?"cbm":"qty",d=a.cap_qty>0?a.qty/a.cap_qty*100:null,e=a.cap_cbm>0?a.cbm/a.cap_cbm*100:null,h=a.total>0?a.filled/a.total*100:0,i=("qty"===b?d:e)??("qty"===b?e:d)??0;return{location_id:g.get(a.wh)??0,code:a.wh,name:c.get(a.wh)??a.wh,basis:b,occ_qty:Math.round(a.qty),cap_qty:Math.round(a.cap_qty),occ_cbm:l(a.cbm),cap_cbm:l(a.cap_cbm),pct:l(i),pct_qty:null===d?null:l(d),pct_cbm:null===e?null:l(e),pct_bin:l(h),status:f(i,a.wh),status_qty:null===d?null:f(d,a.wh),status_cbm:null===e?null:f(e,a.wh),status_bin:f(h,a.wh),sloc_total:a.total,sloc_occupied:a.filled,sloc_empty:a.total-a.filled}}).sort((a,b)=>a.code.localeCompare(b.code));return H={at:Date.now(),rows:h},h})().finally(()=>{I=null}))}async function K(){let a=new Map;for(let b of(await J()))a.set(b.code,{capQ:b.cap_qty,capV:b.cap_cbm,basis:b.basis,slocs:b.sloc_total});return a}function L(a,b){return a.map(a=>{let c=b.filter(b=>b.warehouse===a.code).map(a=>({t:a.t,pct:a.pct})),d=c.length>=3?g(c):0;return{...a,rate_pct_per_hour:m(d),hours_to_95:c.length>=3?h(a.pct,d,95):null,hours_to_100:c.length>=3?h(a.pct,d,100):null}})}async function M(a=36){let[b,c]=await Promise.all([J(),V(a)]);return{summaries:L(b,c),trend:c}}async function N(){return(await M(36)).summaries}async function O(){return(await J()).map(a=>({...a,rate_pct_per_hour:0,hours_to_95:null,hours_to_100:null}))}async function P(){return(0,d.dU)(`${o()}, master AS (
       SELECT m.wh AS warehouse,
              count(*) FILTER (WHERE ${q})::INT AS active_sloc,
              count(*) FILTER (WHERE ${r})::INT AS zoned_sloc,
              count(*) FILTER (WHERE ${q} AND nullif(trim(v.zone), '') IS NULL)::INT AS active_without_zone
       FROM vw_sloc v ${p}
       GROUP BY 1
     ), stock_exception AS (
       SELECT m.wh AS warehouse,
              count(*) FILTER (WHERE v.sloc_code IS NULL OR NOT (${r}))::INT AS stock_without_operational_sloc
       FROM vw_stock_latest s
       JOIN wh_map m ON m.location_id = s.location_id
       LEFT JOIN vw_sloc v ON v.sloc_code = s.sloc_code AND v.location_id = s.location_id
       GROUP BY 1
     )
     SELECT master.warehouse, master.active_sloc, master.zoned_sloc,
            master.active_without_zone,
            coalesce(stock_exception.stock_without_operational_sloc, 0)::INT AS stock_without_operational_sloc
     FROM master LEFT JOIN stock_exception USING (warehouse)
     ORDER BY 1`)}let Q=new Map;async function R(a){let b=s({wh:a,operational:!0});if(a&&!b.wh)return[];let c=b.wh??"*",e=Q.get(c);if(e&&Date.now()-e.at<6e4)return e.rows;let g=[],h=x(),i=(await (0,d.dU)(`${o()}, effective AS (
       SELECT v.sloc_id, v.location_id, v.sloc_code, m.wh, v.zone,
              coalesce(v.rack_zone, '') AS rack_zone, coalesce(v.aisle, '') AS aisle,
              coalesce(v.bay, '') AS bay, coalesce(v.level, '') AS level,
              coalesce(v.bin, '') AS bin, coalesce(v.storage_handling, '') AS storage_handling,
              ${h.basis} AS basis, ${h.capQty} AS cap_qty, ${h.capCbm} AS cap_cbm,
              ${h.qtyValid} AS qty_valid, ${h.cbmValid} AS cbm_valid
       FROM vw_sloc v ${p}
       WHERE ${u(b)}${t(b,g)}
     ), capacities AS (
       SELECT wh, zone, coalesce(max(nullif(storage_handling, '')), '') AS storage,
              sum(CASE WHEN qty_valid THEN cap_qty ELSE 0 END)::DOUBLE AS cap_qty,
              sum(CASE WHEN cbm_valid THEN cap_cbm ELSE 0 END)::DOUBLE AS cap_cbm,
              sum(CASE WHEN basis = 'cbm' THEN 1 ELSE 0 END)::INT AS n_cbm,
              count(*)::INT AS total
       FROM effective GROUP BY wh, zone
     ), stock AS (
       SELECT e.wh, e.zone,
              coalesce(sum(CASE WHEN e.qty_valid THEN s.stock_qty ELSE 0 END), 0)::DOUBLE AS qty,
              coalesce(sum(CASE WHEN e.cbm_valid THEN s.occupied_cbm ELSE 0 END), 0)::DOUBLE AS cbm
       FROM effective e
       JOIN vw_stock_latest s
         ON s.location_id = e.location_id AND s.sloc_code = e.sloc_code
       WHERE ${z("s.status")}
         AND ${y("s.l1_category","e","e")}
       GROUP BY e.wh, e.zone
     ), filled AS (
       SELECT e.wh, e.zone,
              count(DISTINCT CASE
                WHEN s.stock_qty > 0 OR s.occupied_cbm > 0 THEN e.sloc_id
              END)::INT AS filled
       FROM effective e
       JOIN vw_stock_latest s
         ON s.location_id = e.location_id AND s.sloc_code = e.sloc_code
       WHERE ${z("s.status")}
         AND ${y("s.l1_category","e","e")}
       GROUP BY e.wh, e.zone
     )
     SELECT c.wh, c.zone, c.storage, c.cap_qty, c.cap_cbm, c.n_cbm, c.total,
            coalesce(s.qty, 0)::DOUBLE AS qty, coalesce(s.cbm, 0)::DOUBLE AS cbm,
            coalesce(f.filled, 0)::INT AS filled
     FROM capacities c
     LEFT JOIN stock s USING (wh, zone)
     LEFT JOIN filled f USING (wh, zone)
     ORDER BY c.wh, c.zone`,g)).map(a=>{let b=a.n_cbm>a.total/2?"cbm":"qty",c=a.cap_qty>0?a.qty/a.cap_qty*100:null,d=a.cap_cbm>0?a.cbm/a.cap_cbm*100:null,e=a.total>0?a.filled/a.total*100:0,g=("qty"===b?c:d)??("qty"===b?d:c)??0;return{wh:a.wh,zone:a.zone,storage:a.storage,basis:b,occ_qty:Math.round(a.qty),cap_qty:Math.round(a.cap_qty),occ_cbm:l(a.cbm),cap_cbm:l(a.cap_cbm),pct:l(g),pct_qty:null===c?null:l(c),pct_cbm:null===d?null:l(d),pct_bin:l(e),sloc_total:a.total,sloc_occupied:a.filled,sloc_empty:a.total-a.filled,status:f(g,a.wh),status_qty:null===c?null:f(c,a.wh),status_cbm:null===d?null:f(d,a.wh),status_bin:f(e,a.wh)}}).sort((a,b)=>a.wh.localeCompare(b.wh)||a.zone.localeCompare(b.zone));return D(Q,c,{at:Date.now(),rows:i},10),i}async function S(a,b=36){let c=s({wh:a,operational:!0});if(!c.wh)return{};let e=Number.isFinite(b)?Math.min(72,Math.max(12,Math.floor(b))):36,g=`${c.wh}|${e}`,h=B.get(g);if(h&&Date.now()-h.at<6e4)return h.data;let i=await (0,d.dU)(`${o()}, ranked AS (
       SELECT v.sloc_id, v.sloc_code, m.wh, v.zone, v.rack_zone, v.aisle, v.bay, v.level, v.bin,
              v.storage_handling AS storage, v.max_quantity, v.max_volume, v.location_id,
              row_number() OVER (
                PARTITION BY v.zone
                ORDER BY v.rack_zone, v.aisle, v.bay, v.level, v.bin, v.sloc_code
              )::INT AS rn
       FROM vw_sloc v ${p}
       WHERE ${r} AND m.wh = ?
     ), sampled AS (
       SELECT * FROM ranked WHERE rn <= ?
     ), stock_agg AS (
       SELECT p.location_id, p.sloc_code, coalesce(s.l1_category,'') AS l1,
              coalesce(sum(s.stock_qty), 0)::DOUBLE AS qty,
              coalesce(sum(s.occupied_cbm), 0)::DOUBLE AS cbm,
              count(DISTINCT s.product_id)::INT AS pc
       FROM sampled p
       LEFT JOIN vw_stock_latest s
         ON s.location_id = p.location_id AND s.sloc_code = p.sloc_code
        AND ${z("s.status")}
       GROUP BY 1,2,3
     )
     SELECT p.sloc_id, p.sloc_code, p.wh, p.zone, p.rack_zone, p.aisle, p.bay, p.level, p.bin,
            p.storage, p.max_quantity, p.max_volume, p.location_id, p.rn,
            a.l1, a.qty, a.cbm, a.pc
     FROM sampled p
     LEFT JOIN stock_agg a ON a.location_id = p.location_id AND a.sloc_code = p.sloc_code
     ORDER BY p.zone, p.rack_zone, p.aisle, p.bay, p.level, p.bin, p.sloc_code`,[c.wh,e]);if(!i.length){let a={};return D(B,g,{at:Date.now(),data:a},10),a}let q=(a,b)=>`${a}|${b}`,t=new Map,u=new Map;for(let a of i){let b=q(a.location_id,a.sloc_code);t.has(b)||t.set(b,a);let c=t.get(b);if(!c||!k(a.l1,n(c)))continue;let d=u.get(b)??{qty:0,cbm:0,pc:0};d.qty+=a.qty,d.cbm+=a.cbm,d.pc+=a.pc,u.set(b,d)}let v={};for(let a of t.values()){let b=j(n(a)),c=u.get(q(a.location_id,a.sloc_code))??{qty:0,cbm:0,pc:0},d=b.qty_valid&&b.cap_qty>0?c.qty/b.cap_qty*100:null,e=b.cbm_valid&&b.cap_cbm>0?c.cbm/b.cap_cbm*100:null,g=("qty"===b.basis?d:e)??("qty"===b.basis?e:d)??0,h=c.qty>0||c.cbm>0,i={sloc_id:a.sloc_id,sloc_code:a.sloc_code,wh:a.wh,zone:a.zone,rack_zone:a.rack_zone,aisle:a.aisle,bay:a.bay,level:a.level,bin:a.bin,storage:a.storage,basis:b.basis,occ_qty:l(c.qty),cap_qty:l(b.cap_qty),occ_cbm:m(c.cbm),cap_cbm:m(b.cap_cbm),qty_valid:b.qty_valid,cbm_valid:b.cbm_valid,pct_qty:null===d?null:l(d),pct_cbm:null===e?null:l(e),occupied:h,pct_bin:100*!!h,pct:l(g),status:f(g,a.wh),status_qty:null===d?null:f(d,a.wh),status_cbm:null===e?null:f(e,a.wh),status_bin:"NORMAL",product_count:c.pc};(v[a.zone]??=[]).push(i)}return D(B,g,{at:Date.now(),data:v},10),v}async function T(a,b,c=0,e=600){let g=Number.isFinite(c)?Math.max(0,Math.floor(c)):0,h=Number.isFinite(e)?Math.min(1e3,Math.max(100,Math.floor(e))):600,i=s({wh:a,zone:b,operational:!0});if(!i.wh||!i.zone)return{cells:[],total:0,offset:g,nextOffset:null};let q=await (0,d.dU)(`${o()}, scoped AS (
       SELECT v.sloc_id, v.sloc_code, m.wh, v.zone, v.rack_zone, v.aisle, v.bay, v.level, v.bin,
              v.storage_handling AS storage, v.max_quantity, v.max_volume, v.location_id
       FROM vw_sloc v ${p}
       WHERE ${r} AND m.wh = ? AND v.zone = ?
     ), paged AS (
       SELECT *, count(*) OVER ()::INT AS total
       FROM scoped
       ORDER BY rack_zone, aisle, bay, level, bin, sloc_code
       LIMIT ? OFFSET ?
     ), stock_agg AS (
       SELECT p.location_id, p.sloc_code, coalesce(s.l1_category, '') AS l1,
              coalesce(sum(s.stock_qty), 0)::DOUBLE AS qty,
              coalesce(sum(s.occupied_cbm), 0)::DOUBLE AS cbm,
              count(DISTINCT s.product_id)::INT AS pc
       FROM paged p
       LEFT JOIN vw_stock_latest s
         ON s.location_id = p.location_id AND s.sloc_code = p.sloc_code
        AND ${z("s.status")}
       GROUP BY 1, 2, 3
     )
     SELECT p.sloc_id, p.sloc_code, p.wh, p.zone, p.rack_zone, p.aisle, p.bay, p.level, p.bin,
            p.storage, p.max_quantity, p.max_volume, p.location_id, p.total,
            a.l1, a.qty, a.cbm, a.pc
     FROM paged p
     LEFT JOIN stock_agg a
       ON a.location_id = p.location_id AND a.sloc_code = p.sloc_code
     ORDER BY p.rack_zone, p.aisle, p.bay, p.level, p.bin, p.sloc_code`,[i.wh,i.zone,h,g]);if(!q.length)return{cells:[],total:0,offset:g,nextOffset:null};let t=(a,b)=>`${a}|${b}`,u=new Map,v=new Map;for(let a of q){let b=t(a.location_id,a.sloc_code);u.has(b)||u.set(b,a);let c=u.get(b);if(!c||!k(a.l1,n(c)))continue;let d=v.get(b)??{qty:0,cbm:0,pc:0};d.qty+=a.qty,d.cbm+=a.cbm,d.pc+=a.pc,v.set(b,d)}let w=[...u.values()].map(a=>{let b=j(n(a)),c=v.get(t(a.location_id,a.sloc_code))??{qty:0,cbm:0,pc:0},d=b.qty_valid&&b.cap_qty>0?c.qty/b.cap_qty*100:null,e=b.cbm_valid&&b.cap_cbm>0?c.cbm/b.cap_cbm*100:null,g=("qty"===b.basis?d:e)??("qty"===b.basis?e:d)??0,h=c.qty>0||c.cbm>0;return{sloc_id:a.sloc_id,sloc_code:a.sloc_code,wh:a.wh,zone:a.zone,rack_zone:a.rack_zone,aisle:a.aisle,bay:a.bay,level:a.level,bin:a.bin,storage:a.storage,basis:b.basis,occ_qty:l(c.qty),cap_qty:l(b.cap_qty),occ_cbm:m(c.cbm),cap_cbm:m(b.cap_cbm),qty_valid:b.qty_valid,cbm_valid:b.cbm_valid,pct_qty:null===d?null:l(d),pct_cbm:null===e?null:l(e),occupied:h,pct_bin:100*!!h,pct:l(g),status:f(g,a.wh),status_qty:null===d?null:f(d,a.wh),status_cbm:null===e?null:f(e,a.wh),status_bin:"NORMAL",product_count:c.pc}}),x=q[0]?.total??0,y=g+w.length<x?g+w.length:null;return{cells:w,total:x,offset:g,nextOffset:y}}async function U(a,b,c={}){let e=s({wh:a,zone:b,operational:!0});if(!e.wh||!e.zone)return{rows:[],total:0,truncated:!1};let g=Number.isFinite(c.offset)?Math.max(0,Math.floor(c.offset??0)):0,h=Number.isFinite(c.limit)?Math.min(200,Math.max(25,Math.floor(c.limit??100))):100,i=(c.query??"").trim().toLocaleLowerCase().slice(0,120),j={sloc_code:"sloc_code",sku_number:"sku_number",product_name:"product_name",qty:"qty",cbm:"cbm",sloc_pct:"sloc_pct"}[c.sort??"sloc_code"],k="desc"===c.direction?"DESC":"ASC",n=x(),q=await (0,d.dU)(`${o()}, effective AS (
       SELECT v.sloc_id, v.location_id, v.sloc_code, m.wh, v.zone,
              coalesce(v.rack_zone, '') AS rack_zone, coalesce(v.aisle, '') AS aisle,
              coalesce(v.bay, '') AS bay, coalesce(v.level, '') AS level,
              coalesce(v.bin, '') AS bin, coalesce(v.storage_handling, '') AS storage,
              coalesce(v.storage_handling, '') AS storage_handling,
              ${n.basis} AS basis, ${n.capQty} AS cap_qty, ${n.capCbm} AS cap_cbm,
              ${n.qtyValid} AS qty_valid, ${n.cbmValid} AS cbm_valid
       FROM vw_sloc v ${p}
       WHERE ${r} AND m.wh = ? AND v.zone = ?
     ), occupied AS (
       SELECT e.location_id, e.sloc_code,
              coalesce(sum(CASE
                WHEN ${z("s.status")}
                 AND ${y("s.l1_category","e","e")}
                THEN s.stock_qty ELSE 0 END), 0)::DOUBLE AS occ_qty,
              coalesce(sum(CASE
                WHEN ${z("s.status")}
                 AND ${y("s.l1_category","e","e")}
                THEN s.occupied_cbm ELSE 0 END), 0)::DOUBLE AS occ_cbm
       FROM effective e
       LEFT JOIN vw_stock_latest s
         ON s.location_id = e.location_id AND s.sloc_code = e.sloc_code
       GROUP BY e.location_id, e.sloc_code
     ), ratios AS (
       SELECT e.*, o.occ_qty, o.occ_cbm,
              CASE WHEN e.qty_valid AND e.cap_qty > 0
                THEN 100.0 * o.occ_qty / e.cap_qty ELSE NULL END AS pct_qty,
              CASE WHEN e.cbm_valid AND e.cap_cbm > 0
                THEN 100.0 * o.occ_cbm / e.cap_cbm ELSE NULL END AS pct_cbm
       FROM effective e
       JOIN occupied o
         ON o.location_id = e.location_id AND o.sloc_code = e.sloc_code
     ), scored AS (
       SELECT *,
              CASE WHEN basis = 'qty'
                THEN coalesce(pct_qty, pct_cbm, 0)
                ELSE coalesce(pct_cbm, pct_qty, 0)
              END AS sloc_pct
       FROM ratios
     ), stock_rows AS (
       SELECT e.wh, e.location_id, e.sloc_code, e.rack_zone, e.storage,
              s.sku_number, s.product_name, coalesce(s.l1_category, '') AS l1_category,
              s.status, s.stock_qty::DOUBLE AS qty, s.occupied_cbm::DOUBLE AS cbm,
              e.sloc_pct, e.basis AS sloc_basis
       FROM scored e
       JOIN vw_stock_latest s
         ON s.location_id = e.location_id AND s.sloc_code = e.sloc_code
     ), filtered AS (
       SELECT *
       FROM stock_rows
       WHERE (? = '' OR lower(
         coalesce(sloc_code, '') || ' ' || coalesce(sku_number, '') || ' ' ||
         coalesce(product_name, '') || ' ' || coalesce(l1_category, '')
       ) LIKE ?)
     ), details AS (
       SELECT *, count(*) OVER ()::INT AS total
       FROM filtered
       ORDER BY ${j} ${k}, sloc_code ASC, sku_number ASC
       LIMIT ? OFFSET ?
     )
     SELECT total, wh, sloc_code, rack_zone, storage, sku_number, product_name,
            l1_category, status, qty, cbm, sloc_pct, sloc_basis
     FROM details
     ORDER BY ${j} ${k}, sloc_code ASC, sku_number ASC`,[e.wh,e.zone,i,`%${i}%`,h,g]),t=q.map(a=>({sloc_code:a.sloc_code,rack_zone:a.rack_zone,storage:a.storage,sku_number:a.sku_number,product_name:a.product_name,l1_category:a.l1_category,status:a.status,qty:l(a.qty),cbm:m(a.cbm),sloc_pct:l(a.sloc_pct),sloc_basis:a.sloc_basis,sloc_status:f(a.sloc_pct,a.wh)})),u=q[0]?.total??0;return{rows:t,total:u,truncated:g>0||g+t.length<u}}async function V(a=96){let b=Math.max(1,Math.floor(a)),c=C.get(b);if(c&&Date.now()-c.at<6e4)return c.rows;let e=await K(),f=x(),g=(await (0,d.dU)(`${o()}, effective AS (
       SELECT v.location_id, v.sloc_code, m.wh,
              coalesce(v.zone, '') AS zone, coalesce(v.rack_zone, '') AS rack_zone,
              coalesce(v.aisle, '') AS aisle, coalesce(v.bay, '') AS bay,
              coalesce(v.level, '') AS level, coalesce(v.bin, '') AS bin,
              coalesce(v.storage_handling, '') AS storage_handling,
              ${f.qtyValid} AS qty_valid, ${f.cbmValid} AS cbm_valid
       FROM vw_sloc v ${p}
       WHERE ${q}
     )
     SELECT s._synced_at::VARCHAR AS t, e.wh,
            sum(CASE WHEN e.qty_valid THEN s.stock_qty ELSE 0 END)::DOUBLE AS qty,
            sum(CASE WHEN e.cbm_valid THEN s.occupied_cbm ELSE 0 END)::DOUBLE AS cbm,
            count(DISTINCT s.product_id)::INT AS sku,
            count(DISTINCT CASE
              WHEN s.stock_qty > 0 OR s.occupied_cbm > 0
              THEN concat(s.location_id::VARCHAR, '|', s.sloc_code)
            END)::INT AS bins
     FROM stock_history s
     JOIN effective e
       ON e.location_id = s.location_id AND e.sloc_code = s.sloc_code
     WHERE s._synced_at >= now() - INTERVAL ${b} HOUR
       AND ${z("s.status")}
       AND ${y("s.l1_category","e","e")}
     GROUP BY 1, 2 ORDER BY 1 ASC`)).map(a=>{let b=e.get(a.wh)??{capQ:0,capV:0,basis:"qty",slocs:0},c=b.capQ>0?a.qty/b.capQ*100:0,d=b.capV>0?a.cbm/b.capV*100:0,f=b.slocs>0?a.bins/b.slocs*100:0,g="qty"===b.basis?b.capQ>0?c:d:b.capV>0?d:c;return{t:a.t,warehouse:a.wh,pct:l(g),pct_qty:l(c),pct_cbm:l(d),pct_bin:l(f),qty:Math.round(a.qty),sku:a.sku,bins:a.bins}});return D(C,b,{at:Date.now(),rows:g},6),g}async function W(){let a=x(),b=await (0,d.dU)(`${o()}, effective AS (
       SELECT v.location_id, v.sloc_code, m.wh,
              coalesce(v.zone, '') AS zone, coalesce(v.rack_zone, '') AS rack_zone,
              coalesce(v.aisle, '') AS aisle, coalesce(v.bay, '') AS bay,
              coalesce(v.level, '') AS level, coalesce(v.bin, '') AS bin,
              coalesce(v.storage_handling, '') AS storage_handling,
              ${a.qtyValid} AS qty_valid, ${a.cbmValid} AS cbm_valid
       FROM vw_sloc v ${p}
       WHERE ${q}
     ), series AS (
       SELECT e.wh, s.location_id, s.sloc_code, s.product_id, s._synced_at AS t,
              CASE WHEN e.qty_valid THEN s.stock_qty ELSE 0 END AS qty,
              CASE WHEN e.cbm_valid THEN s.occupied_cbm ELSE 0 END AS cbm
       FROM stock_history s
       JOIN effective e
         ON e.location_id = s.location_id AND e.sloc_code = s.sloc_code
       WHERE s._synced_at >= now() - INTERVAL 26 HOUR
         AND ${z("s.status")}
         AND ${y("s.l1_category","e","e")}
     ), d AS (
       SELECT wh, t,
              qty - lag(qty) OVER w AS dq,
              cbm - lag(cbm) OVER w AS dv
       FROM series
       WINDOW w AS (PARTITION BY location_id, sloc_code, product_id ORDER BY t)
     )
     SELECT wh,
            coalesce(sum(CASE WHEN dq > 0 THEN dq END), 0)::DOUBLE  AS in_qty,
            coalesce(-sum(CASE WHEN dq < 0 THEN dq END), 0)::DOUBLE AS out_qty,
            coalesce(sum(CASE WHEN dv > 0 THEN dv END), 0)::DOUBLE  AS in_cbm,
            coalesce(-sum(CASE WHEN dv < 0 THEN dv END), 0)::DOUBLE AS out_cbm,
            greatest(1.0, (epoch(max(t)) - epoch(min(t))) / 3600.0)  AS hours
     FROM d WHERE dq IS NOT NULL GROUP BY wh`),c=new Map;for(let a of b)c.set(a.wh,{wh:a.wh,in_qty:l(a.in_qty/a.hours),out_qty:l(a.out_qty/a.hours),in_cbm:m(a.in_cbm/a.hours),out_cbm:m(a.out_cbm/a.hours)});return c}async function X(){let[a,b,c]=await Promise.all([O(),V(48),W()]);return L(a,b).map(a=>{let d=b.filter(b=>b.warehouse===a.code),e=d[0]?+new Date(d[0].t):0,f=d.length?+new Date(d[d.length-1].t):0,h=e&&f>e?(f-e)/36e5:0,i=d.length>=4&&h>=.25,j=c.get(a.code)??{wh:a.code,in_qty:0,out_qty:0,in_cbm:0,out_cbm:0},k="qty"===a.basis?a.cap_qty:a.cap_cbm;return{warehouse:a.code,name:a.name,basis:a.basis,current_pct:a.pct,rate_pct_per_hour:i?a.rate_pct_per_hour:0,qty_now:a.occ_qty,sku_now:d.length?d[d.length-1].sku:0,qty_rate_per_hour:i?l(g(d.map(a=>({t:a.t,pct:a.qty})))):0,sku_rate_per_hour:i?m(g(d.map(a=>({t:a.t,pct:a.sku})))):0,bin_rate_per_hour:i?m(g(d.map(a=>({t:a.t,pct:a.bins})))):0,bins_now:a.sloc_occupied,sloc_total:a.sloc_total,cap_basis:k,in_rate:"qty"===a.basis?j.in_qty:j.in_cbm,out_rate:"qty"===a.basis?j.out_qty:j.out_cbm,flow_unit:"qty"===a.basis?"unit":"m\xb3",hours_to_95:i?a.hours_to_95:null,hours_to_100:i?a.hours_to_100:null,history_points:d.length,history_span_hours:l(h),forecast_ready:i,trend:d.map(a=>({t:a.t,pct:a.pct}))}})}async function Y(a,b){let c=s({wh:b,operational:!0});if(b&&!c.wh)return{stock:[],movements:[]};let[e,f]=await Promise.all([(0,d.dU)(`${o()}, valid AS (
         SELECT v.location_id, v.sloc_code FROM vw_sloc v ${p}
         WHERE ${r}${c.wh?" AND m.wh = ?":""}
       )
       SELECT product_id, product_name, sku_number, coalesce(l1_category,'') AS l1_category,
               status, stock_qty AS qty, occupied_cbm AS cbm
        FROM vw_stock_latest s
        JOIN valid v ON v.location_id = s.location_id AND v.sloc_code = s.sloc_code
        WHERE s.sloc_code = ?
        ORDER BY occupied_cbm DESC LIMIT 50`,c.wh?[c.wh,a]:[a]),(0,d.dU)(`${o()}, valid AS (
         SELECT v.sloc_code FROM vw_sloc v ${p}
         WHERE ${r}${c.wh?" AND m.wh = ?":""}
       )
       SELECT movement_id, movement_type, movement_datetime::VARCHAR AS at, operator,
               source_sloc, destination_sloc, product_name, qty
        FROM movement_history
        WHERE EXISTS (SELECT 1 FROM valid WHERE sloc_code = ?)
          AND (source_sloc = ? OR destination_sloc = ?)
        ORDER BY movement_datetime DESC LIMIT 12`,c.wh?[c.wh,a,a,a]:[a,a,a]).catch(()=>[])]);return{stock:e,movements:f}}let Z=a=>a?`AND m.wh = '${a.replace(/'/g,"''")}'`:"";async function $(a){return(0,d.dU)(`${o()}, latest_count AS (
       SELECT *, row_number() OVER (PARTITION BY sloc_code ORDER BY count_date DESC) rn
       FROM cycle_count
     ), c AS (SELECT * FROM latest_count WHERE rn = 1)
     SELECT m.wh AS warehouse,
            count(*)::INT AS counted,
            sum(CASE WHEN abs(c.system_qty - c.physical_qty) <= greatest(1, 0.02*c.system_qty) THEN 1 ELSE 0 END)::INT AS matched,
            round(100.0 * sum(CASE WHEN abs(c.system_qty - c.physical_qty) <= greatest(1, 0.02*c.system_qty) THEN 1 ELSE 0 END) / count(*), 1) AS integrity_pct,
            sum(CASE WHEN c.system_qty > 0 AND c.physical_qty = 0 THEN 1 ELSE 0 END)::INT AS phantom,
            sum(CASE WHEN c.system_qty = 0 AND c.physical_qty > 0 THEN 1 ELSE 0 END)::INT AS ghost,
            max(c.count_date)::VARCHAR AS last_count
     FROM c JOIN vw_sloc v ON v.sloc_code = c.sloc_code ${p}
      WHERE ${r} ${Z(a)}
     GROUP BY 1 ORDER BY 1`)}async function _(a=30,b){return(0,d.dU)(`${o()}, latest_count AS (
       SELECT *, row_number() OVER (PARTITION BY sloc_code ORDER BY count_date DESC) rn
       FROM cycle_count
     )
     SELECT m.wh AS warehouse, c.sloc_code, c.count_date::VARCHAR AS count_date,
            c.system_qty, c.physical_qty, (c.physical_qty - c.system_qty) AS diff,
            CASE WHEN c.system_qty > 0 AND c.physical_qty = 0 THEN 'PHANTOM'
                 WHEN c.system_qty = 0 AND c.physical_qty > 0 THEN 'GHOST'
                 ELSE 'SELISIH' END AS drift_type
     FROM latest_count c JOIN vw_sloc v ON v.sloc_code = c.sloc_code ${p}
      WHERE c.rn = 1 AND ${r}
       AND abs(c.system_qty - c.physical_qty) > greatest(1, 0.02*c.system_qty)
       ${Z(b)}
     ORDER BY abs(c.physical_qty - c.system_qty) DESC LIMIT ${Math.max(1,a)}`)}async function aa(){let a=await (0,d.dU)("SELECT max(_synced_at)::VARCHAR AS last, count(*)::BIGINT AS rows FROM stock_history"),b=await (0,d.dU)(`SELECT job, mode, finished_at::VARCHAR AS finished_at, rows_written, status
     FROM _sync_audit ORDER BY finished_at DESC LIMIT 8`).catch(()=>[]);return{last_snapshot:a[0]?.last??null,snapshot_rows:a[0]?.rows??0,recent_syncs:b}}async function ab(a,b=12,c){let e=Math.min(50,Math.max(1,b));return a?(0,d.dU)(`${o()}, valid AS (
         SELECT v.sloc_code FROM vw_sloc v ${p} WHERE ${r}
       )
       SELECT movement_id, movement_type, movement_datetime::VARCHAR AS at, operator,
               source_sloc, destination_sloc, product_name, qty
       FROM movement_history
       WHERE EXISTS (SELECT 1 FROM valid WHERE sloc_code = ?)
         AND (source_sloc = ? OR destination_sloc = ?)
       ORDER BY movement_datetime DESC LIMIT ${e}`,[a,a,a]):(0,d.dU)(`${o()}, valid AS (
        SELECT v.sloc_code, m.wh FROM vw_sloc v ${p} WHERE ${r}
     )
     SELECT h.movement_id, h.movement_type, h.movement_datetime::VARCHAR AS at, h.operator,
            h.source_sloc, h.destination_sloc, h.product_name, h.qty
     FROM movement_history h
     WHERE EXISTS (SELECT 1 FROM valid x WHERE x.sloc_code IN (h.source_sloc, h.destination_sloc)
                   ${c?`AND x.wh = '${c.replace(/'/g,"''")}'`:""})
     ORDER BY h.movement_datetime DESC LIMIT ${e}`)}async function ac(a){let b=`%${a.replace(/'/g,"''")}%`,[c,e]=await Promise.all([(0,d.dU)(`${o()}
       SELECT v.sloc_code, m.wh, v.zone, v.storage_handling AS storage
       FROM vw_sloc v ${p}
        WHERE ${r} AND v.sloc_code ILIKE ? ORDER BY v.sloc_code LIMIT 6`,[b]),(0,d.dU)(`${o()}
       SELECT s.product_name, s.sku_number, m.wh, v.zone, s.sloc_code,
              sum(s.stock_qty)::DOUBLE AS qty
       FROM vw_stock_latest s
       JOIN vw_sloc v
         ON v.location_id = s.location_id AND v.sloc_code = s.sloc_code ${p}
        WHERE ${r} AND (s.product_name ILIKE ? OR s.sku_number ILIKE ?)
       GROUP BY 1, 2, 3, 4, 5
       ORDER BY qty DESC, s.product_name, m.wh, s.sloc_code
       LIMIT 6`,[b,b])]);return{slocs:c,products:e}}async function ad(a,b=90,c=200,e="policy"){let g=s({wh:a,operational:!0});if(a&&!g.wh)return[];let h=Number.isFinite(b)?Math.max(0,b):90,i=Number.isFinite(c)?Math.min(1e3,Math.max(1,Math.floor(c))):200,j=x(),k=g.wh?[g.wh,h,i]:[h,i];return(await (0,d.dU)(`${o()}, effective AS (
       SELECT v.sloc_id, v.location_id, v.sloc_code, m.wh, v.zone,
              coalesce(v.rack_zone, '') AS rack_zone, coalesce(v.aisle, '') AS aisle,
              coalesce(v.bay, '') AS bay, coalesce(v.level, '') AS level,
              coalesce(v.bin, '') AS bin,
              coalesce(v.storage_handling, '') AS storage_handling,
              ${j.basis} AS basis, ${j.capQty} AS cap_qty, ${j.capCbm} AS cap_cbm,
              ${j.qtyValid} AS qty_valid, ${j.cbmValid} AS cbm_valid
       FROM vw_sloc v ${p}
       WHERE ${r}${g.wh?" AND m.wh = ?":""}
     ), stock_agg AS (
       SELECT e.location_id, e.sloc_code,
              coalesce(sum(s.stock_qty), 0)::DOUBLE AS occ_qty,
              coalesce(sum(s.occupied_cbm), 0)::DOUBLE AS occ_cbm,
              count(DISTINCT s.product_id)::INT AS sku_count
       FROM effective e
       JOIN vw_stock_latest s
         ON s.location_id = e.location_id AND s.sloc_code = e.sloc_code
       WHERE ${z("s.status")}
         AND ${y("s.l1_category","e","e")}
       GROUP BY 1, 2
     ), occupancy AS (
       SELECT e.*, coalesce(s.occ_qty, 0)::DOUBLE AS occ_qty,
              coalesce(s.occ_cbm, 0)::DOUBLE AS occ_cbm,
              coalesce(s.sku_count, 0)::INT AS sku_count
       FROM effective e
       LEFT JOIN stock_agg s
         ON s.location_id = e.location_id AND s.sloc_code = e.sloc_code
     ), percentages AS (
       SELECT *,
              CASE WHEN qty_valid AND cap_qty > 0 THEN 100.0 * occ_qty / cap_qty END AS pct_qty,
              CASE WHEN cbm_valid AND cap_cbm > 0 THEN 100.0 * occ_cbm / cap_cbm END AS pct_cbm,
              CASE WHEN occ_qty > 0 OR occ_cbm > 0 THEN 100.0 ELSE 0.0 END AS pct_bin
       FROM occupancy
     ), policy_scored AS (
       SELECT *,
              coalesce(
                CASE WHEN basis = 'qty' THEN pct_qty ELSE pct_cbm END,
                CASE WHEN basis = 'qty' THEN pct_cbm ELSE pct_qty END,
                0
              ) AS pct
       FROM percentages
     ), view_scored AS (
       SELECT *, ${"qty"===e?"pct_qty":"cbm"===e?"pct_cbm":"bin"===e?"pct_bin":"pct"} AS view_pct
       FROM policy_scored
     )
     SELECT sloc_code, wh, zone, storage_handling AS storage, basis,
            round(occ_qty, 1)::DOUBLE AS occ_qty, round(cap_qty, 1)::DOUBLE AS cap_qty,
            round(occ_cbm, 3)::DOUBLE AS occ_cbm, round(cap_cbm, 3)::DOUBLE AS cap_cbm,
            sku_count,
            CASE WHEN pct_qty IS NULL THEN NULL ELSE round(pct_qty, 1)::DOUBLE END AS pct_qty,
            CASE WHEN pct_cbm IS NULL THEN NULL ELSE round(pct_cbm, 1)::DOUBLE END AS pct_cbm,
            round(pct_bin, 1)::DOUBLE AS pct_bin,
            round(view_pct, 1)::DOUBLE AS view_pct,
            qty_valid, cbm_valid
     FROM view_scored
     WHERE view_pct IS NOT NULL AND view_pct >= ?
     ORDER BY view_pct DESC, wh, sloc_code
     LIMIT ?`,k)).map(a=>({sloc_code:a.sloc_code,wh:a.wh,zone:a.zone,storage:a.storage,basis:a.basis,pct:a.view_pct,status:"bin"===e?"NORMAL":f(a.view_pct,a.wh),occ_qty:a.occ_qty,cap_qty:a.cap_qty,occ_cbm:a.occ_cbm,cap_cbm:a.cap_cbm,sku_count:a.sku_count,pct_qty:a.pct_qty,pct_cbm:a.pct_cbm,pct_bin:a.pct_bin,qty_valid:a.qty_valid,cbm_valid:a.cbm_valid}))}},69988:(a,b,c)=>{"use strict";c.d(b,{$$:()=>z,FR:()=>t,J5:()=>r,Q4:()=>s,Zn:()=>w,Zz:()=>u,c1:()=>y,lD:()=>v,sx:()=>x});var d=c(29021),e=c.n(d),f=c(33873),g=c.n(f),h=c(2908);let i=g().join(process.cwd(),"config"),j=h.Ik({default:h.Ik({monitor:h.ai(),warning:h.ai(),critical:h.ai(),breach:h.ai(),hysteresis_buffer:h.ai().default(3)}),overrides:h.g1(h.Yj(),h.Ik({monitor:h.ai().optional(),warning:h.ai().optional(),critical:h.ai().optional(),breach:h.ai().optional(),hysteresis_buffer:h.ai().optional()})).default({})}).superRefine((a,b)=>{let c=(a,c)=>{let d=[a.monitor,a.warning,a.critical,a.breach];d.every(a=>void 0!==a)&&!(d[0]<=d[1]&&d[1]<=d[2]&&d[2]<=d[3])&&b.addIssue({code:"custom",path:c,message:"Ambang harus berurutan: monitor ≤ warning ≤ critical ≤ breach."})};for(let[b,d]of(c(a.default,["default"]),Object.entries(a.overrides)))c({...a.default,...d},["overrides",b])}),k=h.Ik({rules:h.YO(h.Ik({id:h.Yj(),name:h.Yj(),category:h.Yj(),severity:h.k5(["INFO","WARNING","HIGH","CRITICAL","EMERGENCY"]),enabled:h.zM(),params:h.g1(h.Yj(),h.bz()).default({}),description:h.Yj().default("")}))}),l=h.Ik({levels:h.YO(h.Ik({level:h.ai().int().positive(),name:h.Yj().trim().min(1),delay_minutes:h.ai().min(0),gchat_webhooks:h.YO(h.Yj().url()).default([]),webhooks:h.YO(h.Yj().url()).default([]),emails:h.YO(h.Yj().email()).default([])})).min(1),severity_start_level:h.g1(h.Yj(),h.ai().int().positive())}).superRefine((a,b)=>{let c=new Set;for(let[d,e]of a.levels.entries())c.has(e.level)&&b.addIssue({code:"custom",path:["levels",d,"level"],message:"Nomor level harus unik."}),c.add(e.level);for(let[d,e]of Object.entries(a.severity_start_level))c.has(e)||b.addIssue({code:"custom",path:["severity_start_level",d],message:"Level awal harus ada pada daftar eskalasi."})}),m=h.Ik({warehouses:h.YO(h.Ik({code:h.Yj(),location_id:h.ai(),name:h.Yj(),latitude:h.ai().optional(),longitude:h.ai().optional()})).min(1)}).superRefine((a,b)=>{let c=new Set,d=new Set;a.warehouses.forEach((a,e)=>{c.has(a.code)&&b.addIssue({code:"custom",path:["warehouses",e,"code"],message:"Kode warehouse harus unik."}),d.has(a.location_id)&&b.addIssue({code:"custom",path:["warehouses",e,"location_id"],message:"location_id harus unik."}),c.add(a.code),d.add(a.location_id)})}),n=h.Ik({scope:h.Ik({wh:h.Yj().optional(),zone:h.Yj().optional(),rack_zone:h.Yj().optional(),aisle:h.Yj().optional(),bay:h.Yj().optional(),level:h.Yj().optional(),bin:h.Yj().optional(),storage:h.Yj().optional(),l1_category:h.Yj().optional()}).catchall(h.Yj()),set:h.Ik({basis:h.k5(["qty","cbm"]).optional(),max_qty:h.ai().positive().optional(),max_cbm:h.ai().positive().optional(),utilization_pct:h.ai().min(10).max(100).optional(),count:h.zM().optional()}),note:h.Yj().default("")}),o={thresholds:j,rules:k,recipients:l,warehouses:m,capacity:h.Ik({basis_default:h.k5(["qty","cbm"]).default("qty"),utilization_pct:h.ai().min(10).max(100).default(85),count_statuses:h.YO(h.Yj()).min(1).default(["Available"]),exclude_categories:h.YO(h.Yj()).default([]),rules:h.YO(n).default([])}).superRefine((a,b)=>{a.rules.forEach((a,c)=>{let d=!!a.scope.l1_category,e=[a.set.basis,a.set.max_qty,a.set.max_cbm,a.set.utilization_pct].some(a=>void 0!==a);d&&e&&b.addIssue({code:"custom",path:["rules",c],message:"Scope ber-kategori hanya boleh mengatur 'count' (bukan basis/max/utilisasi)."}),void 0===a.set.count||d||b.addIssue({code:"custom",path:["rules",c],message:"'count' hanya berlaku untuk scope ber-kategori."})})})},p=new Map;function q(a){let b=g().join(i,`${a}.json`),c=e().statSync(b),d=p.get(a);if(d&&d.mtime===c.mtimeMs)return d.data;let f=JSON.parse(e().readFileSync(b,"utf-8")),h=o[a].parse(f);return p.set(a,{mtime:c.mtimeMs,data:h}),h}let r=()=>q("thresholds"),s=()=>q("rules"),t=()=>q("recipients"),u=()=>q("warehouses"),v=()=>q("capacity");function w(a,b){let c=o[a].parse(b),d=g().join(i,`${a}.json`);return e().writeFileSync(d,JSON.stringify(c,null,2)),p.delete(a),c}function x(a){let b=r(),c=b.overrides[a]||{};return{monitor:c.monitor??b.default.monitor,warning:c.warning??b.default.warning,critical:c.critical??b.default.critical,breach:c.breach??b.default.breach,hysteresis_buffer:c.hysteresis_buffer??b.default.hysteresis_buffer}}function y(){let a=u().warehouses.map(a=>`(${Number(a.location_id)}, '${a.code.replace(/'/g,"''")}')`).join(", ");return`wh_map(location_id, wh) AS (VALUES ${a})`}function z(){return new Map(u().warehouses.map(a=>[a.code,a.name]))}},78335:()=>{},96487:()=>{}};