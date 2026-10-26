/**
 * INO-1 車両台数3点照合の読み取り専用アダプター。
 *
 * Amazonの2画面は、列名を確認できるまで台数へ変換しない。
 * 既存のスケジュール読取（アソシエイト名 / 配達担当者ID）と、
 * 固定台数マスタは、この照合のソースにしない。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InoichiFleetSourceAdapter = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function fleet() {
    var api = typeof module === 'object' && module.exports ? require('./inoichi-fleet-three-way.js') : null;
    if (!api && typeof window !== 'undefined') api = window.InoichiFleetThreeWay;
    return api;
  }

  function cellsOf(rows) {
    var found = [];
    var limit = Math.min(Array.isArray(rows) ? rows.length : 0, 15);
    for (var r = 0; r < limit; r++) {
      var row = rows[r] || [];
      for (var c = 0; c < row.length; c++) {
        var text = String(row[c] == null ? '' : row[c]).trim();
        if (text) found.push(text);
      }
    }
    return found;
  }

  function hasAll(cells, names) {
    return names.every(function (name) {
      return cells.some(function (cell) { return cell.indexOf(name) >= 0; });
    });
  }

  function blocked(source, reason) {
    return { usable: false, source: source, observations: [], reason: reason };
  }

  function inspectAmazonScheduleRows(rows) {
    var cells = cellsOf(rows);
    if (hasAll(cells, ['アソシエイト名', '配達担当者ID'])) {
      return blocked('amazon_schedule', '既存のAmazonスケジュール読取はアソシエイト名と配達担当者IDだけです。サイクル・車種・台数はないため、人数を台数にしません。');
    }
    return blocked('amazon_schedule', 'Amazonスケジュール画面の台数・サイクル・車種の列は未確認です。');
  }

  function inspectFleetMaster() {
    return blocked(null, '固定台数マスタは3点照合のソースにしません。');
  }

  function stamp(source, rows, fetchedAt) {
    return (Array.isArray(rows) ? rows : []).map(function (row) {
      var copy = {};
      Object.keys(row || {}).forEach(function (key) { copy[key] = row[key]; });
      copy.source = source;
      if (!copy.fetchedAt && fetchedAt) copy.fetchedAt = fetchedAt;
      return copy;
    });
  }

  function collect(input) {
    input = input || {};
    var api = fleet();
    var observations = [];
    var blockedSources = [];
    if (input.fleetMaster) blockedSources.push(inspectFleetMaster());
    if (input.internalExcelRows) {
      var parsed = api.parseInputFileObservations(input.internalExcelRows, input.fetchedAt && input.fetchedAt.internal_excel);
      if (!parsed.ok) blockedSources.push(blocked('internal_excel', parsed.error));
      else observations = observations.concat(parsed.observations);
    }
    if (input.amazonScheduleRows) blockedSources.push(inspectAmazonScheduleRows(input.amazonScheduleRows));
    if (input.amazonScheduleObservations) {
      observations = observations.concat(stamp('amazon_schedule', input.amazonScheduleObservations, input.fetchedAt && input.fetchedAt.amazon_schedule));
    }
    if (input.amazonInputObservations) {
      observations = observations.concat(stamp('amazon_input', input.amazonInputObservations, input.fetchedAt && input.fetchedAt.amazon_input));
    } else if (!input.amazonInputRows) {
      blockedSources.push(blocked('amazon_input', 'Amazon車両台数入力サイトの列は未確認です。'));
    } else {
      blockedSources.push(blocked('amazon_input', 'Amazon車両台数入力サイトの表形式は未確認です。行データだけでは台数にしません。'));
    }
    var compared = api.compareThreeWay(observations);
    compared.blockedSources = blockedSources;
    compared.acquisitionComplete = false;
    return compared;
  }

  return {
    inspectAmazonScheduleRows: inspectAmazonScheduleRows,
    inspectFleetMaster: inspectFleetMaster,
    collect: collect
  };
}));
