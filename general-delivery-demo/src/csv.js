(function (root) {
  'use strict';

  function parseCsv(text) {
    var rows = [];
    var row = [];
    var cell = '';
    var quoted = false;
    var i;
    var src = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (i = 0; i < src.length; i++) {
      var ch = src.charAt(i);
      if (quoted) {
        if (ch === '"') {
          if (src.charAt(i + 1) === '"') {
            cell += '"';
            i++;
          } else {
            quoted = false;
          }
        } else {
          cell += ch;
        }
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ',') {
        row.push(cell.trim());
        cell = '';
      } else if (ch === '\n') {
        row.push(cell.trim());
        if (row.some(function (v) { return v !== ''; })) rows.push(row);
        row = [];
        cell = '';
      } else {
        cell += ch;
      }
    }
    if (cell || row.length) {
      row.push(cell.trim());
      if (row.some(function (v) { return v !== ''; })) rows.push(row);
    }
    return rows;
  }

  function headerIndex(headers, aliases) {
    var map = {};
    headers.forEach(function (h, idx) {
      map[String(h || '').replace(/\s+/g, '').toLowerCase()] = idx;
    });
    for (var i = 0; i < aliases.length; i++) {
      var key = String(aliases[i]).replace(/\s+/g, '').toLowerCase();
      if (map[key] !== undefined) return map[key];
    }
    return -1;
  }

  function rowsToObjects(rows, fields) {
    if (!rows.length) return [];
    var headers = rows[0];
    var indexes = {};
    Object.keys(fields).forEach(function (field) {
      indexes[field] = headerIndex(headers, fields[field]);
    });
    var out = [];
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r];
      var obj = {};
      Object.keys(indexes).forEach(function (field) {
        var idx = indexes[field];
        obj[field] = idx >= 0 ? (row[idx] || '') : '';
      });
      out.push(obj);
    }
    return out;
  }

  function parseDrivers(text) {
    return rowsToObjects(parseCsv(text), {
      name: ['name', '氏名', 'ドライバー名', '名前'],
      id: ['driver_id', 'ドライバーid', 'id'],
      department: ['department', '所属'],
      vehicle: ['vehicle', '車両', '車両タイプ'],
      capability: ['capability', '能力', '個/h'],
      status: ['status', '稼働状態', '状態'],
      areas: ['areas', '経験エリア', 'エリア']
    }).map(function (row, i) {
      return {
        id: row.id || ('D-U' + String(i + 1).padStart(3, '0')),
        name: row.name,
        department: row.department || '未設定',
        vehicle: row.vehicle || 'Van',
        capability: Number(row.capability) || 0,
        status: row.status || '稼働',
        areas: String(row.areas || '').split(/[|/、,]/).map(function (s) { return s.trim(); }).filter(Boolean)
      };
    }).filter(function (row) { return row.name; });
  }

  function parseSchedule(text) {
    return rowsToObjects(parseCsv(text), {
      name: ['name', '氏名', 'ドライバー名'],
      driverId: ['driver_id', 'ドライバーid', 'id'],
      start: ['start', '開始', '出勤'],
      end: ['end', '終了', '退勤'],
      vehicle: ['vehicle', '車両'],
      status: ['status', '稼働状態', '状態']
    }).filter(function (row) { return row.name || row.driverId; });
  }

  function parseRoutes(text) {
    return rowsToObjects(parseCsv(text), {
      id: ['route_id', 'ルートid', 'id', 'route'],
      name: ['name', 'ルート名', 'コース名'],
      area: ['area', 'エリア', '配送エリア'],
      vehicle: ['vehicle', '車両'],
      packages: ['packages', '個口', '配送予定'],
      stops: ['stops', '件数']
    }).map(function (row, i) {
      return {
        id: row.id || ('R-' + String(i + 1).padStart(2, '0')),
        name: row.name || row.area || row.id,
        area: row.area,
        vehicle: row.vehicle || 'Van',
        packages: Number(row.packages) || 0,
        stops: Number(row.stops) || 0,
        assignedDriverId: null
      };
    }).filter(function (row) { return row.id; });
  }

  var api = {
    parseCsv: parseCsv,
    parseDrivers: parseDrivers,
    parseSchedule: parseSchedule,
    parseRoutes: parseRoutes
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.DeliveryCsv = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
