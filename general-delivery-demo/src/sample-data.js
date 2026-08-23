/**
 * Fully fictional showcase data.
 * No real drivers, customer addresses, phone numbers, or carrier IDs.
 */
(function (root) {
  'use strict';

  var DRIVERS = [
    { id: 'D-1001', name: '山田 太郎', department: '第一配送', vehicle: 'Van', capability: 19.2, status: '稼働', areas: ['博多区', '東区'] },
    { id: 'D-1002', name: '佐藤 次郎', department: '第一配送', vehicle: 'Van', capability: 17.8, status: '稼働', areas: ['中央区', '南区'] },
    { id: 'D-1003', name: '鈴木 花子', department: '軽貨物', vehicle: 'Bike', capability: 16.4, status: '稼働', areas: ['中央区', '城南区'] },
    { id: 'D-1004', name: '高橋 美咲', department: '第一配送', vehicle: 'Van', capability: 18.6, status: '稼働', areas: ['東区', '博多区'] },
    { id: 'D-1005', name: '田中 健太', department: '第二配送', vehicle: 'Van', capability: 15.1, status: '稼働', areas: ['南区', '城南区'] },
    { id: 'D-1006', name: '渡辺 翔太', department: '第二配送', vehicle: 'Van', capability: 17.2, status: '稼働', areas: ['西区', '早良区'] },
    { id: 'D-1007', name: '伊藤 さくら', department: '軽貨物', vehicle: 'Bike', capability: 15.8, status: '稼働', areas: ['早良区', '西区'] },
    { id: 'D-1008', name: '中村 大輝', department: '第二配送', vehicle: 'Van', capability: 14.6, status: '稼働', areas: ['西区'] },
    { id: 'D-1009', name: '小林 裕子', department: 'パートナー', vehicle: 'Van', capability: 16.9, status: '稼働', areas: ['城南区', '南区'] },
    { id: 'D-1010', name: '加藤 拓海', department: 'パートナー', vehicle: 'Bike', capability: 14.2, status: '稼働', areas: ['博多区'] },
    { id: 'D-1011', name: '松本 彩花', department: '第一配送', vehicle: 'Van', capability: 18.1, status: '稼働', areas: ['博多区', '中央区'] },
    { id: 'D-1012', name: '吉田 蓮', department: '第二配送', vehicle: 'Van', capability: 13.8, status: '稼働', areas: ['南区'] },
    { id: 'D-1013', name: '山口 真由', department: '第一配送', vehicle: 'Van', capability: 20.4, status: '稼働', areas: ['東区'] },
    { id: 'D-1014', name: '石田 陽介', department: 'パートナー', vehicle: 'Van', capability: 16.0, status: '稼働', areas: ['早良区'] },
    { id: 'D-1015', name: '森 優衣', department: '軽貨物', vehicle: 'Bike', capability: 15.3, status: '稼働', areas: ['中央区'] },
    { id: 'D-1016', name: '池田 悠真', department: '第二配送', vehicle: 'Van', capability: 14.9, status: '稼働', areas: ['西区', '早良区'] },
    { id: 'D-1017', name: '前田 結衣', department: 'パートナー', vehicle: 'Van', capability: 17.5, status: '稼働', areas: ['南区', '中央区'] },
    { id: 'D-1018', name: '藤田 海斗', department: '第一配送', vehicle: 'Van', capability: 16.7, status: '稼働', areas: ['博多区'] },
    { id: 'D-1019', name: '岡田 千尋', department: '第二配送', vehicle: 'Van', capability: 15.6, status: '稼働', areas: ['城南区'] },
    { id: 'D-1020', name: '後藤 涼太', department: 'パートナー', vehicle: 'Van', capability: 13.4, status: '稼働', areas: ['東区'] },
    { id: 'D-1021', name: '長谷川 美月', department: '軽貨物', vehicle: 'Bike', capability: 16.1, status: '稼働', areas: ['早良区', '西区'] },
    { id: 'D-1022', name: '村上 颯太', department: '第一配送', vehicle: 'Van', capability: 18.8, status: '稼働', areas: ['中央区', '博多区'] },
    { id: 'D-1023', name: '近藤 心愛', department: '第二配送', vehicle: 'Van', capability: 14.1, status: '休憩', areas: ['南区'] },
    { id: 'D-1024', name: '坂本 大和', department: 'パートナー', vehicle: 'Van', capability: 15.9, status: '稼働', areas: ['西区', '城南区'] }
  ];

  var SCHEDULE = [
    { driverId: 'D-1001', name: '山田 太郎', start: '09:00', end: '20:00', vehicle: 'Van', status: '稼働' },
    { driverId: 'D-1002', name: '佐藤 次郎', start: '11:00', end: '22:00', vehicle: 'Van', status: '稼働' },
    { driverId: 'D-1003', name: '鈴木 花子', start: '09:00', end: '18:00', vehicle: 'Bike', status: '稼働' },
    { driverId: 'D-1004', name: '高橋 美咲', start: '08:30', end: '19:30', vehicle: 'Van', status: '稼働' },
    { driverId: 'D-1005', name: '田中 健太', start: '09:00', end: '20:00', vehicle: 'Van', status: '稼働' },
    { driverId: 'D-1006', name: '渡辺 翔太', start: '10:00', end: '21:00', vehicle: 'Van', status: '稼働' },
    { driverId: 'D-1007', name: '伊藤 さくら', start: '09:00', end: '17:30', vehicle: 'Bike', status: '稼働' },
    { driverId: 'D-1008', name: '中村 大輝', start: '12:00', end: '22:00', vehicle: 'Van', status: '稼働' },
    { driverId: 'D-1009', name: '小林 裕子', start: '09:00', end: '19:00', vehicle: 'Van', status: '稼働' },
    { driverId: 'D-1010', name: '加藤 拓海', start: '09:30', end: '18:30', vehicle: 'Bike', status: '稼働' },
    { driverId: 'D-1011', name: '松本 彩花', start: '08:45', end: '19:15', vehicle: 'Van', status: '稼働' },
    { driverId: 'D-1012', name: '吉田 蓮', start: '10:00', end: '20:00', vehicle: 'Van', status: '稼働' },
    { driverId: 'D-1013', name: '山口 真由', start: '08:30', end: '18:30', vehicle: 'Van', status: '稼働' },
    { driverId: 'D-1014', name: '石田 陽介', start: '09:00', end: '20:00', vehicle: 'Van', status: '稼働' },
    { driverId: 'D-1015', name: '森 優衣', start: '09:00', end: '18:00', vehicle: 'Bike', status: '稼働' },
    { driverId: 'D-1016', name: '池田 悠真', start: '11:00', end: '21:00', vehicle: 'Van', status: '稼働' },
    { driverId: 'D-1017', name: '前田 結衣', start: '09:00', end: '19:30', vehicle: 'Van', status: '稼働' },
    { driverId: 'D-1018', name: '藤田 海斗', start: '08:50', end: '19:50', vehicle: 'Van', status: '稼働' },
    { driverId: 'D-1019', name: '岡田 千尋', start: '09:15', end: '20:15', vehicle: 'Van', status: '稼働' },
    { driverId: 'D-1020', name: '後藤 涼太', start: '10:30', end: '21:00', vehicle: 'Van', status: '稼働' },
    { driverId: 'D-1021', name: '長谷川 美月', start: '09:00', end: '18:00', vehicle: 'Bike', status: '稼働' },
    { driverId: 'D-1022', name: '村上 颯太', start: '08:40', end: '19:40', vehicle: 'Van', status: '稼働' },
    { driverId: 'D-1023', name: '近藤 心愛', start: '09:00', end: '18:00', vehicle: 'Van', status: '休憩' },
    { driverId: 'D-1024', name: '坂本 大和', start: '09:00', end: '20:00', vehicle: 'Van', status: '稼働' }
  ];

  var ROUTES = [
    { id: 'R-01', name: '博多駅周辺', area: '博多区', vehicle: 'Van', packages: 80, stops: 52, assignedDriverId: 'D-1001' },
    { id: 'R-02', name: '東区香椎方面', area: '東区', vehicle: 'Van', packages: 95, stops: 61, assignedDriverId: 'D-1013' },
    { id: 'R-03', name: '中央区天神周辺', area: '中央区', vehicle: 'Van', packages: 72, stops: 48, assignedDriverId: 'D-1022' },
    { id: 'R-04', name: '南区大橋方面', area: '南区', vehicle: 'Van', packages: 88, stops: 57, assignedDriverId: 'D-1005' },
    { id: 'R-05', name: '西区姪浜方面', area: '西区', vehicle: 'Van', packages: 110, stops: 70, assignedDriverId: 'D-1006' },
    { id: 'R-06', name: '城南区七隈方面', area: '城南区', vehicle: 'Van', packages: 64, stops: 41, assignedDriverId: 'D-1009' },
    { id: 'R-07', name: '早良区西新方面', area: '早良区', vehicle: 'Van', packages: 91, stops: 59, assignedDriverId: 'D-1014' },
    { id: 'R-08', name: '博多区住吉方面', area: '博多区', vehicle: 'Van', packages: 78, stops: 50, assignedDriverId: 'D-1011' },
    { id: 'R-09', name: '東区アイランド方面', area: '東区', vehicle: 'Van', packages: 85, stops: 54, assignedDriverId: 'D-1004' },
    { id: 'R-10', name: '中央区大濠方面', area: '中央区', vehicle: 'Van', packages: 102, stops: 66, assignedDriverId: 'D-1002' },
    { id: 'R-11', name: '南区井尻方面', area: '南区', vehicle: 'Van', packages: 69, stops: 44, assignedDriverId: 'D-1017' },
    { id: 'R-12', name: '西区今宿方面', area: '西区', vehicle: 'Van', packages: 77, stops: 49, assignedDriverId: 'D-1016' },
    { id: 'R-13', name: '城南区別府方面', area: '城南区', vehicle: 'Van', packages: 93, stops: 60, assignedDriverId: 'D-1019' },
    { id: 'R-14', name: '早良区藤崎方面', area: '早良区', vehicle: 'Van', packages: 58, stops: 38, assignedDriverId: null },
    { id: 'R-15', name: '博多区東比恵方面', area: '博多区', vehicle: 'Van', packages: 86, stops: 55, assignedDriverId: 'D-1018' },
    { id: 'R-16', name: '中央区薬院ミニ便', area: '中央区', vehicle: 'Bike', packages: 71, stops: 46, assignedDriverId: 'D-1003' },
    { id: 'R-17', name: '早良区室見ミニ便', area: '早良区', vehicle: 'Bike', packages: 54, stops: 35, assignedDriverId: 'D-1007' },
    { id: 'R-18', name: '西区周船寺方面', area: '西区', vehicle: 'Van', packages: 55, stops: 36, assignedDriverId: null }
  ];

  var EXPERIENCES = [
    { driverId: 'D-1001', area: '博多区', days: 18 },
    { driverId: 'D-1001', area: '東区', days: 6 },
    { driverId: 'D-1002', area: '中央区', days: 21 },
    { driverId: 'D-1002', area: '南区', days: 9 },
    { driverId: 'D-1003', area: '中央区', days: 14 },
    { driverId: 'D-1003', area: '城南区', days: 4 },
    { driverId: 'D-1004', area: '東区', days: 16 },
    { driverId: 'D-1004', area: '博多区', days: 8 },
    { driverId: 'D-1005', area: '南区', days: 12 },
    { driverId: 'D-1005', area: '城南区', days: 3 },
    { driverId: 'D-1006', area: '西区', days: 20 },
    { driverId: 'D-1006', area: '早良区', days: 7 },
    { driverId: 'D-1007', area: '早良区', days: 11 },
    { driverId: 'D-1007', area: '西区', days: 5 },
    { driverId: 'D-1008', area: '西区', days: 4 },
    { driverId: 'D-1009', area: '城南区', days: 15 },
    { driverId: 'D-1009', area: '南区', days: 6 },
    { driverId: 'D-1010', area: '博多区', days: 7 },
    { driverId: 'D-1011', area: '博多区', days: 13 },
    { driverId: 'D-1011', area: '中央区', days: 10 },
    { driverId: 'D-1012', area: '南区', days: 5 },
    { driverId: 'D-1013', area: '東区', days: 22 },
    { driverId: 'D-1014', area: '早良区', days: 17 },
    { driverId: 'D-1015', area: '中央区', days: 9 },
    { driverId: 'D-1016', area: '西区', days: 8 },
    { driverId: 'D-1016', area: '早良区', days: 4 },
    { driverId: 'D-1017', area: '南区', days: 14 },
    { driverId: 'D-1017', area: '中央区', days: 6 },
    { driverId: 'D-1018', area: '博多区', days: 11 },
    { driverId: 'D-1019', area: '城南区', days: 10 },
    { driverId: 'D-1020', area: '東区', days: 3 },
    { driverId: 'D-1021', area: '早良区', days: 12 },
    { driverId: 'D-1021', area: '西区', days: 6 },
    { driverId: 'D-1022', area: '中央区', days: 19 },
    { driverId: 'D-1022', area: '博多区', days: 8 },
    { driverId: 'D-1023', area: '南区', days: 2 },
    { driverId: 'D-1024', area: '西区', days: 9 },
    { driverId: 'D-1024', area: '城南区', days: 5 }
  ];

  var AREA_COORDS = {
    '博多区': { lat: 33.590, lng: 130.420 },
    '東区': { lat: 33.650, lng: 130.430 },
    '中央区': { lat: 33.589, lng: 130.398 },
    '南区': { lat: 33.560, lng: 130.415 },
    '西区': { lat: 33.585, lng: 130.335 },
    '城南区': { lat: 33.565, lng: 130.370 },
    '早良区': { lat: 33.580, lng: 130.360 }
  };

  var TIME_WINDOWS = [
    { id: 'TW-01', routeId: 'R-01', driverId: 'D-1001', area: '博多区', address: '福岡市博多区デモ駅前1-2-3', window: '10:00〜12:00', note: '' },
    { id: 'TW-02', routeId: 'R-01', driverId: 'D-1001', area: '博多区', address: '福岡市博多区サンプル通2-4-1', window: '14:00〜16:00', note: '' },
    { id: 'TW-03', routeId: 'R-01', driverId: 'D-1001', area: '博多区', address: '福岡市博多区架空町3-1-8', window: '16:00〜18:00', note: '' },
    { id: 'TW-04', routeId: 'R-03', driverId: 'D-1022', area: '中央区', address: '福岡市中央区デモ公園4-2-6', window: '10:00〜12:00', note: '' },
    { id: 'TW-05', routeId: 'R-03', driverId: 'D-1022', area: '中央区', address: '福岡市中央区サンプル坂1-8-2', window: '14:00〜16:00', note: '' },
    { id: 'TW-06', routeId: 'R-03', driverId: 'D-1022', area: '中央区', address: '福岡市中央区架空通り5-3-1', window: '18:00〜20:00', note: '18時指定' },
    { id: 'TW-07', routeId: 'R-03', driverId: 'D-1022', area: '中央区', address: '福岡市中央区デモ橋6-1-4', window: '18:00〜20:00', note: '18時指定' },
    { id: 'TW-08', routeId: 'R-05', driverId: 'D-1006', area: '西区', address: '福岡市西区デモ浜1-3-9', window: '10:00〜12:00', note: '' },
    { id: 'TW-09', routeId: 'R-05', driverId: 'D-1006', area: '西区', address: '福岡市西区サンプル台2-7-5', window: '14:00〜16:00', note: '' },
    { id: 'TW-10', routeId: 'R-05', driverId: 'D-1006', area: '西区', address: '福岡市西区架空丘3-2-2', window: '16:00〜18:00', note: '' },
    { id: 'TW-11', routeId: 'R-05', driverId: 'D-1006', area: '西区', address: '福岡市西区デモ海岸4-8-1', window: '18:00〜20:00', note: '18時指定' },
    { id: 'TW-12', routeId: 'R-02', driverId: 'D-1013', area: '東区', address: '福岡市東区デモ浜1-1-6', window: '10:00〜12:00', note: '' },
    { id: 'TW-13', routeId: 'R-02', driverId: 'D-1013', area: '東区', address: '福岡市東区サンプル丘2-5-3', window: '14:00〜16:00', note: '' },
    { id: 'TW-14', routeId: 'R-02', driverId: 'D-1013', area: '東区', address: '福岡市東区架空緑地3-4-7', window: '16:00〜18:00', note: '' },
    { id: 'TW-15', routeId: 'R-04', driverId: 'D-1005', area: '南区', address: '福岡市南区デモ大橋1-6-2', window: '10:00〜12:00', note: '' },
    { id: 'TW-16', routeId: 'R-04', driverId: 'D-1005', area: '南区', address: '福岡市南区サンプル野2-3-8', window: '14:00〜16:00', note: '' },
    { id: 'TW-17', routeId: 'R-06', driverId: 'D-1009', area: '城南区', address: '福岡市城南区デモ大学前1-2-5', window: '14:00〜16:00', note: '' },
    { id: 'TW-18', routeId: 'R-06', driverId: 'D-1009', area: '城南区', address: '福岡市城南区架空台2-9-1', window: '16:00〜18:00', note: '' },
    { id: 'TW-19', routeId: 'R-07', driverId: 'D-1014', area: '早良区', address: '福岡市早良区デモ西新1-4-3', window: '10:00〜12:00', note: '' },
    { id: 'TW-20', routeId: 'R-07', driverId: 'D-1014', area: '早良区', address: '福岡市早良区サンプル通り2-1-7', window: '18:00〜20:00', note: '18時指定' },
    { id: 'TW-21', routeId: 'R-08', driverId: 'D-1011', area: '博多区', address: '福岡市博多区デモ住吉1-8-4', window: '14:00〜16:00', note: '' },
    { id: 'TW-22', routeId: 'R-08', driverId: 'D-1011', area: '博多区', address: '福岡市博多区架空橋2-6-2', window: '16:00〜18:00', note: '' },
    { id: 'TW-23', routeId: 'R-08', driverId: 'D-1011', area: '博多区', address: '福岡市博多区サンプル川3-3-9', window: '18:00〜20:00', note: '18時指定' },
    { id: 'TW-24', routeId: 'R-09', driverId: 'D-1004', area: '東区', address: '福岡市東区デモ島1-5-1', window: '10:00〜12:00', note: '' },
    { id: 'TW-25', routeId: 'R-09', driverId: 'D-1004', area: '東区', address: '福岡市東区架空港2-2-6', window: '16:00〜18:00', note: '' },
    { id: 'TW-26', routeId: 'R-10', driverId: 'D-1002', area: '中央区', address: '福岡市中央区デモ濠1-7-3', window: '10:00〜12:00', note: '' },
    { id: 'TW-27', routeId: 'R-10', driverId: 'D-1002', area: '中央区', address: '福岡市中央区サンプル杜2-4-8', window: '14:00〜16:00', note: '' },
    { id: 'TW-28', routeId: 'R-10', driverId: 'D-1002', area: '中央区', address: '福岡市中央区架空園3-1-2', window: '18:00〜20:00', note: '18時指定' },
    { id: 'TW-29', routeId: 'R-11', driverId: 'D-1017', area: '南区', address: '福岡市南区デモ井尻1-3-5', window: '14:00〜16:00', note: '' },
    { id: 'TW-30', routeId: 'R-12', driverId: 'D-1016', area: '西区', address: '福岡市西区サンプル今宿1-9-4', window: '16:00〜18:00', note: '' },
    { id: 'TW-31', routeId: 'R-13', driverId: 'D-1019', area: '城南区', address: '福岡市城南区デモ別府1-6-7', window: '10:00〜12:00', note: '' },
    { id: 'TW-32', routeId: 'R-13', driverId: 'D-1019', area: '城南区', address: '福岡市城南区架空原2-8-3', window: '18:00〜20:00', note: '18時指定' },
    { id: 'TW-33', routeId: 'R-15', driverId: 'D-1018', area: '博多区', address: '福岡市博多区デモ東比恵1-2-9', window: '14:00〜16:00', note: '' },
    { id: 'TW-34', routeId: 'R-15', driverId: 'D-1018', area: '博多区', address: '福岡市博多区サンプル駅南2-5-4', window: '16:00〜18:00', note: '' },
    { id: 'TW-35', routeId: 'R-16', driverId: 'D-1003', area: '中央区', address: '福岡市中央区デモ薬院1-4-6', window: '10:00〜12:00', note: '' },
    { id: 'TW-36', routeId: 'R-16', driverId: 'D-1003', area: '中央区', address: '福岡市中央区架空坂2-1-1', window: '14:00〜16:00', note: '' },
    { id: 'TW-37', routeId: 'R-16', driverId: 'D-1003', area: '中央区', address: '福岡市中央区サンプル小路3-7-2', window: '16:00〜18:00', note: '' },
    { id: 'TW-38', routeId: 'R-17', driverId: 'D-1007', area: '早良区', address: '福岡市早良区デモ室見1-8-5', window: '10:00〜12:00', note: '' },
    { id: 'TW-39', routeId: 'R-17', driverId: 'D-1007', area: '早良区', address: '福岡市早良区架空川2-3-8', window: '14:00〜16:00', note: '' },
    { id: 'TW-40', routeId: 'R-01', driverId: 'D-1001', area: '博多区', address: '福岡市博多区デモ祇園1-9-2', window: '18:00〜20:00', note: '18時指定' },
    { id: 'TW-41', routeId: 'R-01', driverId: 'D-1001', area: '博多区', address: '福岡市博多区サンプル中洲2-2-7', window: '18:00〜20:00', note: '18時指定' },
    { id: 'TW-42', routeId: 'R-01', driverId: 'D-1001', area: '博多区', address: '福岡市博多区架空冷泉3-6-1', window: '14:00〜16:00', note: '' },
    { id: 'TW-43', routeId: 'R-04', driverId: 'D-1005', area: '南区', address: '福岡市南区デモ高宮1-5-8', window: '18:00〜20:00', note: '18時指定' }
  ];

  function offsetFor(index) {
    var angle = (index * 47) % 360;
    var dist = 0.004 + ((index * 13) % 7) * 0.0012;
    var rad = angle * Math.PI / 180;
    return {
      lat: Math.cos(rad) * dist,
      lng: Math.sin(rad) * dist * 1.2
    };
  }

  function withCoordinates(items) {
    return items.map(function (item, index) {
      var base = AREA_COORDS[item.area] || AREA_COORDS['博多区'];
      var off = offsetFor(index + 1);
      return Object.assign({}, item, {
        lat: Math.round((base.lat + off.lat) * 100000) / 100000,
        lng: Math.round((base.lng + off.lng) * 100000) / 100000
      });
    });
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function summarize(data) {
    var working = data.drivers.filter(function (d) { return d.status === '稼働'; }).length;
    var packages = data.routes.reduce(function (sum, r) { return sum + r.packages; }, 0);
    var unassigned = data.routes.filter(function (r) { return !r.assignedDriverId; }).length;
    var evening = data.timeWindows.filter(function (t) { return t.window === '18:00〜20:00'; }).length;
    return {
      workingDrivers: working,
      routes: data.routes.length,
      packages: packages,
      timeWindows: data.timeWindows.length,
      unassignedRoutes: unassigned,
      eveningWindows: evening
    };
  }

  function createSampleDataset() {
    var data = {
      drivers: clone(DRIVERS),
      schedule: clone(SCHEDULE),
      routes: clone(ROUTES),
      experiences: clone(EXPERIENCES),
      timeWindows: withCoordinates(clone(TIME_WINDOWS))
    };
    data.summary = summarize(data);
    return data;
  }

  var api = {
    createSampleDataset: createSampleDataset,
    AREA_COORDS: AREA_COORDS
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.DeliverySampleData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
