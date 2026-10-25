/**
 * 累計データの出力モデル（DriverCumulative.buildOutputModel）を .xlsx にする最小ライタ。
 * SheetJS(CE) は書式を書き出せないため、既存のドライバー別配送データの見た目
 * （濃紺ヘッダー＋白文字、固定ペイン、列幅、0.00_ 表示形式、Carlito 11pt）を JSZip で直接再現する。
 * DOM非依存。JSZip は引数で受け取る（ブラウザは window.JSZip、テストは require('jszip')）。
 */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function colName(i) {
    var s = '';
    for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    return s;
  }
  function strCell(ref, text, style) {
    return '<c r="' + ref + '"' + (style ? ' s="' + style + '"' : '') + ' t="inlineStr"><is><t xml:space="preserve">' + esc(text) + '</t></is></c>';
  }
  function numCell(ref, n, style) {
    return '<c r="' + ref + '"' + (style ? ' s="' + style + '"' : '') + '><v>' + String(n) + '</v></c>';
  }

  var STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="176" formatCode="0.00_ "/></numFmts>' +
    '<fonts count="2"><font><sz val="11"/><name val="Carlito"/></font><font><sz val="11"/><color rgb="FFFFFFFF"/><name val="Carlito"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FF17365D"/></patternFill></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="4">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
    '<xf numFmtId="176" fontId="1" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>' +
    '<xf numFmtId="176" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  function dataSheetXml(sheet, selected) {
    var ncol = sheet.columns.length, nrow = sheet.rows.length + 1;
    var cols = sheet.columns.map(function (c, i) {
      return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + c.width + '"' + (c.fmt ? ' style="3"' : '') + ' customWidth="1"/>';
    }).join('');
    var xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<dimension ref="A1:' + colName(ncol - 1) + nrow + '"/>' +
      '<sheetViews><sheetView' + (selected ? ' tabSelected="1"' : '') + ' workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="14.25"/><cols>' + cols + '</cols><sheetData>';
    xml += '<row r="1">' + sheet.columns.map(function (c, i) { return strCell(colName(i) + '1', c.header, c.fmt ? 2 : 1); }).join('') + '</row>';
    sheet.rows.forEach(function (row, r) {
      var rn = r + 2;
      xml += '<row r="' + rn + '">';
      row.forEach(function (v, i) {
        var ref = colName(i) + rn, c = sheet.columns[i];
        if (v == null || v === '') return;
        if (typeof v === 'number') xml += numCell(ref, v, c.fmt ? 3 : 0);
        else xml += strCell(ref, v, 0);
      });
      xml += '</row>';
    });
    return xml + '</sheetData></worksheet>';
  }

  function noteSheetXml(sheet) {
    var w = sheet.widths || [25, 85];
    var xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<dimension ref="A1:B' + Math.max(1, sheet.rows.length) + '"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="14.25"/><cols><col min="1" max="1" width="' + w[0] + '" customWidth="1"/><col min="2" max="2" width="' + w[1] + '" customWidth="1"/></cols><sheetData>';
    sheet.rows.forEach(function (row, r) {
      xml += '<row r="' + (r + 1) + '">' + strCell('A' + (r + 1), row[0], 0) + strCell('B' + (r + 1), row[1] == null ? '' : row[1], 0) + '</row>';
    });
    return xml + '</sheetData></worksheet>';
  }

  /** @returns {Promise<Uint8Array>} */
  function buildXlsx(model, JSZip) {
    var zip = new JSZip();
    var n = model.sheets.length;
    var ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>';
    var wbSheets = '', wbRels = '';
    model.sheets.forEach(function (s, i) {
      ct += '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
      wbSheets += '<sheet name="' + esc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
      wbRels += '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
      zip.file('xl/worksheets/sheet' + (i + 1) + '.xml', s.kind === 'note' ? noteSheetXml(s) : dataSheetXml(s, i === 0));
    });
    wbRels += '<Relationship Id="rId' + (n + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>';
    zip.file('[Content_Types].xml', ct + '</Types>');
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
    zip.file('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + wbSheets + '</sheets></workbook>');
    zip.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + wbRels + '</Relationships>');
    zip.file('xl/styles.xml', STYLES);
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  }

  var api = { buildXlsx: buildXlsx };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.DriverCumulativeXlsx = api;
})(typeof window !== 'undefined' ? window : globalThis);
