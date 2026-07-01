<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>配送管理 - OFK3</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
  <script src="https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/qrious@4.0.2/dist/qrious.min.js"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            surface: '#FAFAF8',
            ink: '#2D2D2D',
            'ink-light': '#6B6B6B',
            'ink-lighter': '#9A9A9A',
            accent: '#D94032',
            'accent-light': '#FDF2F1',
            border: '#E8E8E6',
            'card-bg': '#FFFFFF',
          },
          fontFamily: {
            sans: ['"Noto Sans JP"', 'Inter', 'sans-serif'],
            mono: ['"JetBrains Mono"', 'monospace'],
          }
        }
      }
    }
  </script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    body { background: #FAFAF8; }
    .upload-zone { border: 2px dashed #E8E8E6; transition: all 0.2s; }
    .upload-zone:hover, .upload-zone.dragover { border-color: #D94032; background: #FDF2F1; }
    .fade-in { animation: fadeIn 0.3s ease-out; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; }
    .tab-active { border-bottom: 2px solid #D94032; color: #2D2D2D; font-weight: 500; }
    .tab-inactive { border-bottom: 2px solid transparent; color: #9A9A9A; }
    .tab-inactive:hover { color: #6B6B6B; }
    .btn-primary { background: #D94032; color: white; transition: all 0.15s; }
    .btn-primary:hover { background: #C13529; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(217,64,50,0.3); }
    .btn-secondary { background: white; border: 1px solid #E8E8E6; color: #2D2D2D; transition: all 0.15s; }
    .btn-secondary:hover { border-color: #D94032; color: #D94032; }
    .card { background: white; border: 1px solid #E8E8E6; border-radius: 8px; transition: box-shadow 0.2s; }
    .card:hover { box-shadow: 0 2px 12px rgba(0,0,0,0.06); }
    .progress-bar { height: 4px; border-radius: 2px; background: #E8E8E6; }
    .progress-fill { height: 100%; border-radius: 2px; transition: width 0.5s ease-out; }
    .tooltip { position: relative; }
    .tooltip::after { content: attr(data-tip); position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); background: #2D2D2D; color: white; padding: 4px 8px; border-radius: 4px; font-size: 11px; white-space: nowrap; opacity: 0; pointer-events: none; transition: opacity 0.2s; }
    .tooltip:hover::after { opacity: 1; }
    input[type="file"] { display: none; }
    .optimization-badge { background: #FDF2F1; color: #D94032; border: 1px solid #D94032; border-radius: 4px; font-size: 11px; padding: 2px 6px; }

    /* Print Styles */
    @media print {
      body { background: white !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      #app > header, #app > main > nav, #upload-section, .btn-primary, .btn-secondary, #line-modal, #settings-modal { display: none !important; }
      #panel-dashboard { display: block !important; }
      #dashboard-content { display: block !important; }
      .card { border: none !important; box-shadow: none !important; }
      #print-header { display: block !important; }
      #stat-bar-print { display: none; }
      .no-print { display: none !important; }
    }
    #print-header { display: none; }

    /* Print Preview Modal */
    .print-preview-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .print-preview-table th { background: #F5F5F5; border: 1px solid #DDD; padding: 6px 10px; font-weight: 600; text-align: left; }
    .print-preview-table td { border: 1px solid #DDD; padding: 5px 10px; }
    .print-preview-table tr:nth-child(even) { background: #FAFAFA; }
  </style>
</head>
<body class="min-h-screen text-ink">
  <div id="app">
    <!-- Header -->
    <header class="bg-card-bg border-b border-border px-6 py-3 flex items-center justify-between sticky top-0 z-50">
      <div class="flex items-center gap-3">
        <img src="logo.png" alt="OFK3" class="h-9 w-9 object-contain rounded">
        <div class="flex items-center gap-4">
          <h1 class="text-lg font-bold tracking-tight">配送管理</h1>
          <span class="text-xs text-ink-lighter font-mono bg-surface px-2 py-0.5 rounded">OFK3</span>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <span class="text-sm text-ink-light" id="today-date"></span>
        <button class="btn-secondary text-xs px-3 py-1.5 rounded-md" onclick="showSettings()">設定</button>
      </div>
    </header>

    <!-- Main Content -->
    <main class="max-w-7xl mx-auto px-6 py-6">
      <!-- Tabs -->
      <nav class="flex gap-6 mb-6 border-b border-border">
        <button class="tab-active pb-3 text-sm" onclick="switchTab('dashboard')" id="tab-dashboard">本日のダッシュボード</button>
        <button class="tab-inactive pb-3 text-sm" onclick="switchTab('drivers')" id="tab-drivers">ドライバー管理</button>
        <button class="tab-inactive pb-3 text-sm" onclick="switchTab('master')" id="tab-master">マスタ管理</button>
        <button class="tab-inactive pb-3 text-sm" onclick="switchTab('optimization')" id="tab-optimization">コース最適化</button>
        <button class="tab-inactive pb-3 text-sm" onclick="switchTab('tenko')" id="tab-tenko">点呼管理</button>
        <button class="tab-inactive pb-3 text-sm" onclick="switchTab('billing')" id="tab-billing">請求照合</button>
      </nav>

      <!-- Dashboard Tab -->
      <div id="panel-dashboard">
        <!-- Upload Section -->
        <div id="upload-section">
          <div class="grid grid-cols-2 gap-4">
            <!-- Cycle / Address Data Upload -->
            <div class="upload-zone rounded-lg p-8 text-center cursor-pointer" id="upload-zone-cycle" onclick="document.getElementById('cycle-file-input').click()">
              <input type="file" id="cycle-file-input" accept=".xlsx,.xls" onchange="handleCycleDataUpload(event)" style="display:none;">
              <div class="mb-2">
                <svg class="w-8 h-8 mx-auto text-ink-lighter" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"/>
                </svg>
              </div>
              <p class="text-sm font-medium text-ink mb-1">住所データ（コース詳細）</p>
              <p class="text-xs text-ink-lighter">OFK3_CYCLE...xlsx</p>
              <p class="text-xs text-ink-lighter mt-1" id="cycle-status"></p>
            </div>
            <!-- Assign Data Upload -->
            <div class="upload-zone rounded-lg p-8 text-center cursor-pointer" id="upload-zone-assign" onclick="document.getElementById('file-input').click()">
              <input type="file" id="file-input" accept=".xlsx,.xls,.csv" onchange="handleFileUpload(event)">
              <div class="mb-2">
                <svg class="w-8 h-8 mx-auto text-ink-lighter" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                </svg>
              </div>
              <p class="text-sm font-medium text-ink mb-1">アサインデータ</p>
              <p class="text-xs text-ink-lighter">ルート_OFK3...xlsx</p>
              <p class="text-xs text-ink-lighter mt-1" id="assign-status"></p>
            </div>
          </div>
        </div>

        <!-- Dashboard Content (after upload) -->
        <div id="dashboard-content" class="hidden fade-in">
          <!-- Summary Stats -->
          <div class="grid grid-cols-4 gap-4 mb-6">
            <div class="card p-4">
              <p class="text-xs text-ink-lighter mb-1">総ルート数</p>
              <p class="text-2xl font-bold font-mono" id="stat-routes">-</p>
            </div>
            <div class="card p-4">
              <p class="text-xs text-ink-lighter mb-1">稼働ドライバー</p>
              <p class="text-2xl font-bold font-mono" id="stat-drivers">-</p>
            </div>
            <div class="card p-4">
              <p class="text-xs text-ink-lighter mb-1">総配達数</p>
              <p class="text-2xl font-bold font-mono" id="stat-packages">-</p>
            </div>
            <div class="card p-4">
              <p class="text-xs text-ink-lighter mb-1">予測最終完了</p>
              <p class="text-2xl font-bold font-mono" id="stat-latest">-</p>
            </div>
          </div>

          <!-- Route Table -->
          <div class="card overflow-hidden">
            <div class="px-4 py-3 border-b border-border flex items-center justify-between">
              <h2 class="text-sm font-medium">ルート別配送予測</h2>
              <div class="flex items-center gap-2">
                <button class="btn-secondary text-xs px-3 py-1 rounded" onclick="document.getElementById('file-input').click()">データ更新</button>
                <button class="btn-secondary text-xs px-3 py-1 rounded" onclick="openPrintPreview()">
                  <span class="inline-flex items-center gap-1">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/></svg>
                    印刷・掲示用
                  </span>
                </button>
                <button class="text-xs px-3 py-1 rounded text-white transition-all hover:opacity-90" style="background:#06C755;" onclick="openLineSendModal()">
                  <span class="inline-flex items-center gap-1">
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="white"><path d="M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.627-.63h2.386c.349 0 .63.285.63.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.104.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.627-.63.349 0 .631.285.631.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.281.629-.629.629M12 1C5.373 1 0 5.373 0 12s5.373 11 12 11 12-4.373 12-11S18.627 1 12 1"/></svg>
                    LINE送信
                  </span>
                </button>
              </div>
            </div>
            <div class="overflow-x-auto">
              <table class="w-full text-sm table-fixed">
                <thead>
                  <tr class="border-b border-border bg-surface">
                    <th class="px-4 py-2.5 text-left text-xs font-medium text-ink-lighter uppercase tracking-wider w-32">ドライバー</th>
                    <th class="px-4 py-2.5 text-left text-xs font-medium text-ink-lighter uppercase tracking-wider w-20">ルート</th>
                    <th class="px-4 py-2.5 text-left text-xs font-medium text-ink-lighter uppercase tracking-wider" style="min-width: 280px;">エリア</th>
                    <th class="px-4 py-2.5 text-left text-xs font-medium text-ink-lighter uppercase tracking-wider w-20">サービス</th>
                    <th class="px-4 py-2.5 text-right text-xs font-medium text-ink-lighter uppercase tracking-wider w-16">配達数</th>
                    <th class="px-4 py-2.5 text-right text-xs font-medium text-ink-lighter uppercase tracking-wider w-16">目的地</th>
                    <th class="px-4 py-2.5 text-right text-xs font-medium text-ink-lighter uppercase tracking-wider w-20">能力(個/h)</th>
                    <th class="px-4 py-2.5 text-left text-xs font-medium text-ink-lighter uppercase tracking-wider w-16">出発</th>
                    <th class="px-4 py-2.5 text-left text-xs font-medium text-ink-lighter uppercase tracking-wider w-20">予測終了</th>
                    <th class="px-4 py-2.5 text-left text-xs font-medium text-ink-lighter uppercase tracking-wider w-24">ステータス</th>
                  </tr>
                </thead>
                <tbody id="route-table-body">
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <!-- Drivers Tab -->
      <div id="panel-drivers" class="hidden">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-sm font-medium">ドライバー能力データベース</h2>
          <div class="flex gap-2">
            <button class="btn-secondary text-xs px-3 py-1.5 rounded" onclick="document.getElementById('driver-file-input').click()">実績データ更新</button>
            <input type="file" id="driver-file-input" accept=".xlsx,.xls,.csv" onchange="handleDriverDataUpload(event)">
            <button onclick="printAllQR()" class="btn-secondary text-xs px-3 py-1.5 rounded">🖨 QR一括印刷</button>
          </div>
        </div>
        <p class="text-xs text-ink-lighter mb-4">週次で更新されるドライバーの配送実績。予測エンジンの基礎データとして使用されます。</p>

        <div class="card overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border bg-surface">
                  <th class="px-4 py-2.5 text-left text-xs font-medium text-ink-lighter uppercase tracking-wider">ドライバー名</th>
                  <th class="px-4 py-2.5 text-right text-xs font-medium text-ink-lighter uppercase tracking-wider">個/時間</th>
                  <th class="px-4 py-2.5 text-right text-xs font-medium text-ink-lighter uppercase tracking-wider">配管率%</th>
                  <th class="px-4 py-2.5 text-right text-xs font-medium text-ink-lighter uppercase tracking-wider">誤配率%</th>
                  <th class="px-4 py-2.5 text-right text-xs font-medium text-ink-lighter uppercase tracking-wider">稼働日数</th>
                  <th class="px-4 py-2.5 text-right text-xs font-medium text-ink-lighter uppercase tracking-wider">総配送数</th>
                  <th class="px-4 py-2.5 text-right text-xs font-medium text-ink-lighter uppercase tracking-wider">正配依頼</th>
                  <th class="px-4 py-2.5 text-left text-xs font-medium text-ink-lighter uppercase tracking-wider">最終更新</th>
                </tr>
              </thead>
              <tbody id="driver-table-body">
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- Master Management Tab -->
      <div id="panel-master" class="hidden">
        <div class="flex items-center justify-between mb-4">
          <div>
            <h2 class="text-sm font-medium">マスタ管理</h2>
            <p class="text-xs text-ink-lighter mt-1">ドライバーのLINE ID紐付け・基本情報の管理</p>
          </div>
          <div class="flex gap-2">
            <button class="btn-secondary text-xs px-3 py-1.5 rounded" onclick="addNewDriver()">+ ドライバー追加</button>
            <button class="btn-secondary text-xs px-3 py-1.5 rounded" onclick="exportMasterData()">エクスポート</button>
          </div>
        </div>

        <!-- Search -->
        <div class="mb-4">
          <input type="text" id="master-search" placeholder="ドライバー名で検索..." class="border border-border rounded px-3 py-2 text-sm w-64 focus:outline-none focus:border-accent" oninput="renderMasterTable()">
        </div>

        <!-- Master Table -->
        <div class="card overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border bg-surface">
                  <th class="px-4 py-2.5 text-left text-xs font-medium text-ink-lighter uppercase tracking-wider">ステータス</th>
                  <th class="px-4 py-2.5 text-left text-xs font-medium text-ink-lighter uppercase tracking-wider">名前（日本語）</th>
                  <th class="px-4 py-2.5 text-left text-xs font-medium text-ink-lighter uppercase tracking-wider">ドライバー名</th>
                  <th class="px-4 py-2.5 text-left text-xs font-medium text-ink-lighter uppercase tracking-wider">LINE ID</th>
                  <th class="px-4 py-2.5 text-left text-xs font-medium text-ink-lighter uppercase tracking-wider">電話番号</th>
                  <th class="px-4 py-2.5 text-left text-xs font-medium text-ink-lighter uppercase tracking-wider">Transport ID</th>
                  <th class="px-4 py-2.5 text-left text-xs font-medium text-ink-lighter uppercase tracking-wider">所属</th>
                  <th class="px-4 py-2.5 text-center text-xs font-medium text-ink-lighter uppercase tracking-wider">QRコード</th>
                  <th class="px-4 py-2.5 text-left text-xs font-medium text-ink-lighter uppercase tracking-wider">連携状態</th>
                  <th class="px-4 py-2.5 text-left text-xs font-medium text-ink-lighter uppercase tracking-wider">メモ</th>
                  <th class="px-4 py-2.5 text-left text-xs font-medium text-ink-lighter uppercase tracking-wider">操作</th>
                </tr>
              </thead>
              <tbody id="master-table-body">
              </tbody>
            </table>
          </div>
        </div>

        <!-- Summary -->
        <div class="mt-4 flex items-center gap-6 text-xs text-ink-lighter">
          <span id="master-total">合計: 0名</span>
          <span id="master-linked">LINE紐付け済み: 0名</span>
          <span id="master-unlinked">未紐付け: 0名</span>
        </div>
      </div>

      <!-- Optimization Tab -->
      <div id="panel-optimization" class="hidden">
        <div class="flex items-center justify-between mb-4">
          <div>
            <h2 class="text-sm font-medium">コース割最適化提案</h2>
            <p class="text-xs text-ink-lighter mt-1">ドライバー能力に基づいて、現在のAmazonアサインからの改善案を提示します</p>
          </div>
          <button class="btn-primary text-xs px-4 py-1.5 rounded" onclick="runOptimization()" id="optimize-btn">最適化を実行</button>
        </div>

        <div id="optimization-results" class="hidden fade-in">
          <!-- Will be populated dynamically -->
        </div>

        <div id="optimization-empty" class="text-center py-16">
          <p class="text-sm text-ink-lighter">アサインデータとドライバー実績データの両方をアップロードした後、最適化を実行できます</p>
        </div>
      </div>

      <!-- Tenko (Roll Call) Management Tab -->
      <div id="panel-tenko" class="hidden">
        <div class="flex items-center justify-between mb-4">
          <div>
            <h2 class="text-sm font-medium">点呼管理</h2>
            <p class="text-xs text-ink-lighter mt-1">シフトデータから当日の点呼スケジュールを生成し、認証状況をリアルタイム管理</p>
          </div>
          <div class="flex gap-2">
            <button class="btn-secondary text-xs px-3 py-1.5 rounded" onclick="document.getElementById('shift-file-input').click()">シフトデータ読み込み</button>
            <input type="file" id="shift-file-input" accept=".xlsx,.xls" class="hidden" onchange="handleShiftUpload(event)">
            <button id="auto-scan-btn" class="text-xs px-4 py-1.5 rounded font-bold bg-blue-500 text-white hover:bg-blue-600 transition-colors" onclick="toggleAutoScan()">🔄 自動認証モード</button>
            <button class="btn-secondary text-xs px-3 py-1.5 rounded" onclick="resetTenkoStatus()">認証リセット</button>
          </div>
        </div>

        <!-- Tenko Summary Cards -->
        <div class="grid grid-cols-4 gap-4 mb-6" id="tenko-summary">
          <div class="card p-4">
            <div class="text-xs text-ink-lighter">本日予定</div>
            <div class="text-2xl font-bold mt-1" id="tenko-total">-</div>
          </div>
          <div class="card p-4">
            <div class="text-xs text-ink-lighter">完了</div>
            <div class="text-2xl font-bold mt-1 text-emerald-600" id="tenko-done">0</div>
          </div>
          <div class="card p-4">
            <div class="text-xs text-ink-lighter">認証中</div>
            <div class="text-2xl font-bold mt-1 text-amber-500" id="tenko-progress">0</div>
          </div>
          <div class="card p-4">
            <div class="text-xs text-ink-lighter">未実施</div>
            <div class="text-2xl font-bold mt-1 text-ink-lighter" id="tenko-pending">0</div>
          </div>
        </div>

        <!-- Auto Scan Camera Panel -->
        <div id="auto-scan-panel" class="hidden mb-6">
          <div class="card p-4">
            <div class="flex items-center justify-between mb-3">
              <div>
                <h3 id="scan-status-title" class="text-base font-bold text-blue-600">🪪 QRコードをかざしてください</h3>
                <p id="scan-status-detail" class="text-xs text-ink-lighter mt-1">ドライバーのQRコードをカメラに向けてください</p>
              </div>
              <div id="scan-driver-badge" class="hidden px-3 py-1 rounded-full bg-blue-100 text-blue-700 text-sm font-bold"></div>
            </div>
            <div class="flex gap-4">
              <div class="flex-1">
                <div id="qr-reader" style="width:100%;max-width:480px" class="rounded-lg overflow-hidden"></div>
                <canvas id="ocr-canvas" class="hidden"></canvas>
                <video id="ocr-video" class="hidden" autoplay playsinline muted></video>
                <div id="ocr-preview" class="hidden rounded-lg overflow-hidden mt-2" style="max-width:480px">
                  <video id="ocr-display-video" class="w-full" autoplay playsinline muted></video>
                </div>
              </div>
              <div id="scan-log" class="flex-1 max-h-64 overflow-y-auto">
                <h4 class="text-xs font-bold text-ink-lighter mb-2">認証ログ</h4>
                <div id="scan-log-entries" class="space-y-1 text-xs"></div>
              </div>
            </div>
          </div>
        </div>

        <!-- LINE自動通知コントロール -->
        <div class="card p-4 mb-4">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-bold flex items-center gap-2">📩 LINE自動通知</h3>
            <span id="line-notify-master-status" class="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">有効</span>
          </div>
          <div id="line-notify-slots" class="space-y-2">
          </div>
          <div id="line-notify-log" class="mt-3 max-h-32 overflow-y-auto hidden">
            <h4 class="text-xs font-bold text-ink-lighter mb-1">送信ログ</h4>
            <div id="line-notify-log-entries" class="space-y-1"></div>
          </div>
        </div>

        <!-- Tenko Schedule Table -->
        <div class="card overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border bg-surface">
                  <th class="px-4 py-2.5 text-left text-xs font-medium text-ink-lighter uppercase tracking-wider">ドライバー名</th>
                  <th class="px-4 py-2.5 text-center text-xs font-medium text-ink-lighter uppercase tracking-wider">着車時間</th>
                  <th class="px-4 py-2.5 text-center text-xs font-medium text-ink-lighter uppercase tracking-wider">QR認証</th>
                  <th class="px-4 py-2.5 text-center text-xs font-medium text-ink-lighter uppercase tracking-wider">メンター認証</th>
                  <th class="px-4 py-2.5 text-center text-xs font-medium text-ink-lighter uppercase tracking-wider">ステータス</th>
                  <th class="px-4 py-2.5 text-center text-xs font-medium text-ink-lighter uppercase tracking-wider">操作</th>
                </tr>
              </thead>
              <tbody id="tenko-table-body">
              </tbody>
            </table>
          </div>
        </div>

        <div id="tenko-empty" class="text-center py-16">
          <p class="text-sm text-ink-lighter">シフトデータをアップロードすると、当日の点呼スケジュールが表示されます</p>
        </div>
      </div>

      <!-- Billing Tab -->
      <div id="panel-billing" class="hidden">
        <div class="flex items-center justify-between mb-4">
          <div>
            <h2 class="text-lg font-bold">請求金額照合</h2>
            <p class="text-sm text-ink-lighter">個人事業主ドライバーへの請求金額通知・LINE一斉送信</p>
          </div>
          <div class="flex gap-2">
            <label class="btn-secondary text-xs px-3 py-1.5 rounded cursor-pointer">
              📂 請求Excel読込
              <input type="file" accept=".xlsx,.xls" onchange="handleBillingUpload(event)" class="hidden" id="billing-file-input">
            </label>
          </div>
        </div>

        <div id="billing-dropzone" class="text-center py-16 mb-4 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-green-400 hover:bg-green-50/50 transition-colors"
          onclick="document.getElementById('billing-file-input').click()"
          ondragover="event.preventDefault(); this.classList.add('border-green-400','bg-green-50')"
          ondragleave="this.classList.remove('border-green-400','bg-green-50')"
          ondrop="event.preventDefault(); this.classList.remove('border-green-400','bg-green-50'); handleDropFile(event, 'billing')">
          <div class="text-4xl mb-3">💰</div>
          <p class="text-sm font-medium text-ink-lighter">請求Excelをドラッグ＆ドロップ</p>
          <p class="text-xs text-gray-400 mt-1">またはクリックしてファイルを選択</p>
        </div>

        <div id="billing-summary" class="hidden mb-4">
          <div class="grid grid-cols-3 gap-3">
            <div class="card p-3 text-center">
              <div class="text-2xl font-bold text-blue-600" id="billing-total-count">0</div>
              <div class="text-xs text-ink-lighter">対象者数</div>
            </div>
            <div class="card p-3 text-center">
              <div class="text-2xl font-bold text-green-600" id="billing-total-amount">¥0</div>
              <div class="text-xs text-ink-lighter">合計金額(税込)</div>
            </div>
            <div class="card p-3 text-center">
              <div class="text-2xl font-bold text-purple-600" id="billing-line-count">0</div>
              <div class="text-xs text-ink-lighter">LINE送信可能</div>
            </div>
          </div>
        </div>

        <div id="billing-actions" class="hidden mb-4 flex gap-2">
          <button onclick="sendAllBillingLine()" class="bg-green-500 text-white px-4 py-2 rounded text-sm font-bold hover:bg-green-600 cursor-pointer">📩 LINE一斉送信</button>
          <button onclick="previewBillingMessage()" class="btn-secondary text-xs px-3 py-1.5 rounded cursor-pointer">👁 メッセージプレビュー</button>
        </div>

        <div id="billing-send-log" class="hidden mb-4 card p-3">
          <h4 class="text-xs font-bold text-ink-lighter mb-2">送信ログ</h4>
          <div id="billing-log-entries" class="space-y-1 max-h-32 overflow-y-auto"></div>
        </div>

        <div class="card overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border bg-surface">
                  <th class="px-3 py-2 text-left text-xs font-medium text-ink-lighter">選択</th>
                  <th class="px-3 py-2 text-left text-xs font-medium text-ink-lighter">宛名</th>
                  <th class="px-3 py-2 text-right text-xs font-medium text-ink-lighter">稼働日数</th>
                  <th class="px-3 py-2 text-right text-xs font-medium text-ink-lighter">チャーター</th>
                  <th class="px-3 py-2 text-right text-xs font-medium text-ink-lighter">走行距離</th>
                  <th class="px-3 py-2 text-right text-xs font-medium text-ink-lighter">控除</th>
                  <th class="px-3 py-2 text-right text-xs font-medium text-ink-lighter">税別</th>
                  <th class="px-3 py-2 text-right text-xs font-medium text-ink-lighter">税</th>
                  <th class="px-3 py-2 text-right text-xs font-medium text-ink-lighter">システム使用料</th>
                  <th class="px-3 py-2 text-right text-xs font-medium text-ink-lighter font-bold">合計</th>
                  <th class="px-3 py-2 text-center text-xs font-medium text-ink-lighter">LINE</th>
                  <th class="px-3 py-2 text-center text-xs font-medium text-ink-lighter">状態</th>
                </tr>
              </thead>
              <tbody id="billing-table-body">
                <tr><td colspan="12" class="text-center py-8 text-ink-lighter text-sm">請求Excelを読み込んでください</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

    </main>

    <!-- QR Code Modal -->
    <div id="qr-modal" class="hidden fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div class="bg-white rounded-lg shadow-xl w-full max-w-sm mx-4 p-6 text-center" style="position:relative;z-index:51">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold">点呼認証QRコード</h3>
          <button onclick="closeQrModal()" class="text-gray-400 hover:text-gray-600 text-2xl">&times;</button>
        </div>
        <p id="qr-modal-name" class="text-base font-bold mb-1"></p>
        <p id="qr-modal-data" class="text-xs text-ink-lighter mb-4"></p>
        <div id="qr-modal-render" class="mx-auto" style="display:inline-block;padding:24px;background:#fff;border-radius:8px"></div>
        <div class="flex gap-2 mt-4" style="position:relative;z-index:52">
          <button onclick="downloadQR(document.getElementById('qr-modal-name').textContent)" class="flex-1 py-2 rounded text-xs font-medium bg-blue-100 text-blue-700 hover:bg-blue-200 transition-colors cursor-pointer">📥 ダウンロード</button>
          <button onclick="printQR(document.getElementById('qr-modal-name').textContent)" class="flex-1 py-2 rounded text-xs font-medium bg-gray-100 text-ink hover:bg-gray-200 transition-colors cursor-pointer">🖨 印刷</button>
          <button onclick="closeQrModal()" class="flex-1 py-2 rounded text-xs font-medium bg-gray-100 text-ink hover:bg-gray-200 transition-colors cursor-pointer">閉じる</button>
        </div>
      </div>
    </div>

    <!-- Camera Authentication Modal -->
    <div id="camera-modal" class="hidden fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div class="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4 p-6">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold">点呼認証</h3>
          <button onclick="closeCameraModal()" class="text-gray-400 hover:text-gray-600 text-2xl">&times;</button>
        </div>
        <p class="text-sm text-ink-lighter mb-1">ドライバー: <span id="camera-driver-name" class="font-bold text-ink"></span></p>
        <p id="camera-auth-type" class="text-base font-bold mb-3 text-blue-600"></p>
        <div class="bg-black rounded-lg overflow-hidden mb-3" style="aspect-ratio:1/1;max-width:400px;margin:0 auto">
          <video id="camera-video" class="w-full h-full" style="object-fit:cover" autoplay playsinline muted></video>
        </div>
        <div id="camera-result" class="text-sm mt-2"></div>
        <div class="flex gap-2 mt-4">
          <button id="camera-confirm-btn" onclick="confirmCameraAuth()" class="flex-1 py-3 rounded-lg text-sm font-bold bg-emerald-500 text-white hover:bg-emerald-600 transition-colors text-lg">認証OK</button>
          <button onclick="closeCameraModal()" class="px-4 py-3 rounded-lg text-sm font-medium bg-gray-100 text-ink hover:bg-gray-200 transition-colors">閉じる</button>
        </div>
      </div>
    </div>

    <!-- LINE Notification Modal -->
    <div id="line-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center">
      <div class="absolute inset-0 bg-black/30" onclick="closeModal()"></div>
      <div class="relative bg-white rounded-lg p-6 max-w-md w-full mx-4 shadow-xl fade-in">
        <h3 class="text-base font-bold mb-2">配送計画を確定して通知</h3>
        <p class="text-sm text-ink-light mb-4">以下の内容でドライバーにLINE通知を送信します。</p>

        <!-- Notification Mode Toggle -->
        <div class="flex gap-2 mb-4">
          <button class="text-xs px-3 py-1.5 rounded border transition-all" id="mode-notify" onclick="setNotifyMode('notify')">グループ一括（Notify）</button>
          <button class="text-xs px-3 py-1.5 rounded border transition-all" id="mode-messaging" onclick="setNotifyMode('messaging')">個別送信（Messaging API）</button>
        </div>

        <div class="bg-surface rounded p-3 mb-4 text-xs font-mono max-h-48 overflow-y-auto" id="notification-preview">
        </div>

        <!-- Status Messages -->
        <div id="line-not-configured" class="flex items-center gap-2 p-3 bg-accent-light rounded mb-4">
          <svg class="w-4 h-4 text-accent flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
          <p class="text-xs text-accent">LINE連携が未設定です。設定画面からトークンを入力してください。</p>
        </div>
        <div id="line-ready" class="hidden flex items-center gap-2 p-3 bg-emerald-50 rounded mb-4">
          <svg class="w-4 h-4 text-emerald-600 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>
          <p class="text-xs text-emerald-700">LINE連携済み。通知を送信できます。</p>
        </div>

        <div class="flex gap-2 justify-end">
          <button class="btn-secondary text-sm px-4 py-2 rounded" onclick="closeModal()">キャンセル</button>
          <button class="btn-primary text-sm px-4 py-2 rounded" id="send-line-btn" onclick="sendLineNotification()">通知を送信</button>
        </div>
      </div>
    </div>

    <!-- Settings Modal -->
    <div id="settings-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center">
      <div class="absolute inset-0 bg-black/30" onclick="closeSettings()"></div>
      <div class="relative bg-white rounded-lg p-6 max-w-2xl w-full mx-4 shadow-xl fade-in max-h-[90vh] overflow-y-auto">
        <h3 class="text-base font-bold mb-4">設定</h3>
        <div class="space-y-6">

          <!-- LINE Notify Section -->
          <div class="border border-border rounded-lg p-4">
            <div class="flex items-center gap-2 mb-3">
              <svg class="w-5 h-5" viewBox="0 0 24 24" fill="#06C755"><path d="M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.627-.63h2.386c.349 0 .63.285.63.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.104.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.627-.63.349 0 .631.285.631.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.281.629-.629.629M12 1C5.373 1 0 5.373 0 12s5.373 11 12 11 12-4.373 12-11S18.627 1 12 1"/></svg>
              <h4 class="text-sm font-bold">LINE Notify（グループ一括通知）</h4>
              <span class="text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-700" id="notify-status">未設定</span>
            </div>
            <p class="text-xs text-ink-lighter mb-3">LINEグループに全ドライバーの配送予測をまとめて投稿します。</p>
            <div class="space-y-2">
              <label class="text-xs font-medium text-ink-light">アクセストークン</label>
              <input type="text" id="line-notify-token" placeholder="LINE Notify トークンを貼り付け" class="w-full border border-border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent" oninput="saveLineSettings()">
              <p class="text-xs text-ink-lighter">取得方法: <a href="https://notify-bot.line.me/my/" target="_blank" class="text-accent underline">notify-bot.line.me</a> → トークンを発行 → グループを選択</p>
            </div>
            <button class="btn-secondary text-xs px-3 py-1.5 rounded mt-3" onclick="testLineNotify()">テスト送信</button>
          </div>

          <!-- LINE Messaging API Section -->
          <div class="border border-border rounded-lg p-4">
            <div class="flex items-center gap-2 mb-3">
              <svg class="w-5 h-5" viewBox="0 0 24 24" fill="#06C755"><path d="M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.627-.63h2.386c.349 0 .63.285.63.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.104.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.627-.63.349 0 .631.285.631.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.281.629-.629.629M12 1C5.373 1 0 5.373 0 12s5.373 11 12 11 12-4.373 12-11S18.627 1 12 1"/></svg>
              <h4 class="text-sm font-bold">Messaging API（個別通知）</h4>
              <span class="text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-700" id="messaging-status">未設定</span>
            </div>
            <p class="text-xs text-ink-lighter mb-3">各ドライバーに個別でコース・物量・終了予測を送信します。</p>
            <div class="space-y-3">
              <div>
                <label class="text-xs font-medium text-ink-light">チャネルアクセストークン</label>
                <input type="text" id="line-channel-token" placeholder="Channel Access Token（長期）" class="w-full border border-border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent mt-1" oninput="saveLineSettings()">
              </div>
              <div>
                <label class="text-xs font-medium text-ink-light">チャネルシークレット</label>
                <input type="text" id="line-channel-secret" placeholder="Channel Secret" class="w-full border border-border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent mt-1" oninput="saveLineSettings()">
              </div>
              <p class="text-xs text-ink-lighter">取得方法: <a href="https://developers.line.biz/console/" target="_blank" class="text-accent underline">LINE Developers Console</a> → プロバイダー作成 → Messaging APIチャネル作成</p>
            </div>

            <!-- Driver LINE ID Mapping -->
            <div class="mt-4 pt-4 border-t border-border">
              <div class="flex items-center justify-between mb-2">
                <label class="text-xs font-bold text-ink">ドライバー × LINE ID 紐付け</label>
                <button class="text-xs text-accent underline" onclick="addDriverLineMapping()">+ 追加</button>
              </div>
              <p class="text-xs text-ink-lighter mb-2">ドライバーが公式アカウントを友だち追加した後、LINE IDを紐付けてください。</p>
              <div id="line-mapping-list" class="space-y-1.5 max-h-40 overflow-y-auto">
                <!-- Populated dynamically -->
              </div>
            </div>

            <!-- Admin LINE ID -->
            <div class="mt-4 pt-4 border-t border-border">
              <label class="text-xs font-bold text-ink">管理者 LINE ID</label>
              <p class="text-xs text-ink-lighter mb-2 mt-1">管理者には全ルート・全ドライバーの予測一覧が送信されます。複数指定する場合はカンマで区切ってください。</p>
              <input type="text" id="line-admin-id" placeholder="U...,U..." class="w-full border border-border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent" oninput="saveLineSettings()">
            </div>

            <!-- LINE Bot Basic ID -->
            <div class="mt-4 pt-4 border-t border-border">
              <label class="text-xs font-bold text-ink">LINE公式アカウント ID</label>
              <p class="text-xs text-ink-lighter mb-2 mt-1">マスタ管理画面に友だち追加用QRコードを表示します（例: @046vllck）。</p>
              <input type="text" id="line-bot-id" placeholder="@で始まるBasic ID" class="w-full border border-border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent" oninput="saveLineSettings()">
            </div>

            <!-- LINE Bot Logo URL -->
            <div class="mt-4 pt-4 border-t border-border">
              <label class="text-xs font-bold text-ink">LINE公式アカウント ロゴ画像URL</label>
              <p class="text-xs text-ink-lighter mb-2 mt-1">マスタ管理の友だち追加ボタンに表示する画像URLを入力してください。</p>
              <input type="text" id="line-bot-logo-url" placeholder="https://.../logo.png" class="w-full border border-border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent" oninput="saveLineSettings()">
            </div>

            <!-- GAS Proxy URL -->
            <div class="mt-4 pt-4 border-t border-border">
              <label class="text-xs font-bold text-ink">GASプロキシ URL</label>
              <p class="text-xs text-ink-lighter mb-2 mt-1">LINE API用のGoogle Apps Script WebアプリURLを入力してください。</p>
              <input type="text" id="gas-proxy-url" placeholder="https://script.google.com/macros/s/.../exec" class="w-full border border-border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent" oninput="saveLineSettings()">
            </div>
          </div>

          <!-- General Settings -->
          <div class="border border-border rounded-lg p-4">
            <h4 class="text-sm font-bold mb-2">配送設定</h4>
            <p class="text-xs text-ink-lighter mb-3">ステーション: 〒819-0022 福岡市西区福重3丁目36-24</p>
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="text-xs font-medium text-ink-light">デフォルト出発時刻</label>
                <input type="time" value="09:00" class="border border-border rounded px-3 py-2 text-sm focus:outline-none focus:border-accent w-full mt-1" id="default-departure">
              </div>
              <div>
                <label class="text-xs font-medium text-ink-light">積み込み時間（分）</label>
                <input type="number" value="15" min="0" max="60" class="border border-border rounded px-3 py-2 text-sm w-full focus:outline-none focus:border-accent mt-1" id="loading-time">
              </div>
              <div>
                <label class="text-xs font-medium text-ink-light">往路 ステーション→配送エリア（分）</label>
                <input type="number" value="20" min="0" max="90" class="border border-border rounded px-3 py-2 text-sm w-full focus:outline-none focus:border-accent mt-1" id="travel-outbound">
                <p class="text-xs text-ink-lighter mt-0.5">西区福重 → 配送先エリアまでの平均移動時間</p>
              </div>
              <div>
                <label class="text-xs font-medium text-ink-light">帰庫 配送エリア→ステーション（分）</label>
                <input type="number" value="20" min="0" max="90" class="border border-border rounded px-3 py-2 text-sm w-full focus:outline-none focus:border-accent mt-1" id="travel-return">
                <p class="text-xs text-ink-lighter mt-0.5">配送先最終地点 → ステーションまでの平均移動時間</p>
              </div>
            </div>
            <div class="mt-3 p-2 bg-surface rounded text-xs text-ink-light">
              <strong>計算式:</strong> 出発時刻 + 積み込み + 往路移動 + (配達数 ÷ 能力値) + 帰庫移動
            </div>
          </div>

          <!-- Notification Template -->
          <div class="border border-border rounded-lg p-4">
            <h4 class="text-sm font-bold mb-3">通知テンプレート（個別送信時）</h4>
            <textarea id="line-message-template" rows="9" class="w-full border border-border rounded px-3 py-2 text-xs font-mono focus:outline-none focus:border-accent" oninput="saveLineSettings()">おはようございます！
本日の配送情報です：

コース: {route}
エリア: {area}
配達数: {packages}個
目的地: {destinations}件
出発予定: {departure}
終了目安: {predicted_end}

メンターの起動をお願いします！
安全運転でお願いします！</textarea>
            <p class="text-xs text-ink-lighter mt-1">変数: {driver}, {route}, {area}, {packages}, {destinations}, {departure}, {predicted_end}</p>
          </div>

        </div>
        <div class="flex justify-end mt-6">
          <button class="btn-primary text-sm px-4 py-2 rounded" onclick="closeSettings()">保存して閉じる</button>
        </div>
      </div>
    </div>

    <!-- Print Preview Modal -->
    <div id="print-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center">
      <div class="absolute inset-0 bg-black/30" onclick="closePrintPreview()"></div>
      <div class="relative bg-white rounded-lg p-6 max-w-4xl w-full mx-4 shadow-xl fade-in max-h-[90vh] overflow-y-auto">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-base font-bold">点呼場掲示用 — ルート別配送予測表</h3>
          <div class="flex items-center gap-2">
            <button class="btn-secondary text-xs px-3 py-1.5 rounded" onclick="closePrintPreview()">閉じる</button>
            <button class="btn-primary text-xs px-3 py-1.5 rounded" onclick="printTable()">
              <span class="inline-flex items-center gap-1">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/></svg>
                印刷する
              </span>
            </button>
          </div>
        </div>
        <div id="print-content">
          <!-- Will be populated dynamically -->
        </div>
      </div>
    </div>
  </div>

  <script>
    // ===== State =====
    let assignmentData = [];
    let driverDB = {};
    let currentTab = 'dashboard';

    // Initialize
    document.getElementById('today-date').textContent = new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });

    // Load saved driver data from localStorage
    const savedDrivers = localStorage.getItem('driverDB');
    if (savedDrivers) {
      driverDB = JSON.parse(savedDrivers);
      renderDriverTable();
    }

    // ===== Tab Navigation =====
    function switchTab(tab) {
      currentTab = tab;
      ['dashboard', 'drivers', 'master', 'optimization', 'tenko', 'billing'].forEach(t => {
        document.getElementById(`panel-${t}`).classList.toggle('hidden', t !== tab);
        document.getElementById(`tab-${t}`).className = t === tab ? 'tab-active pb-3 text-sm' : 'tab-inactive pb-3 text-sm';
      });
      if (tab === 'master') {
        renderMasterTable();
        refreshAllLineProfiles();
      }
      if (tab === 'billing') renderBillingTable();
    }

    // ===== File Upload - Assignment Data =====
    const assignZone = document.getElementById('upload-zone-assign');
    assignZone.addEventListener('dragover', (e) => { e.preventDefault(); assignZone.classList.add('dragover'); });
    assignZone.addEventListener('dragleave', () => { assignZone.classList.remove('dragover'); });
    assignZone.addEventListener('drop', (e) => {
      e.preventDefault();
      assignZone.classList.remove('dragover');
      if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });

    // ===== File Upload - Cycle/Address Data =====
    const cycleZone = document.getElementById('upload-zone-cycle');
    cycleZone.addEventListener('dragover', (e) => { e.preventDefault(); cycleZone.classList.add('dragover'); });
    cycleZone.addEventListener('dragleave', () => { cycleZone.classList.remove('dragover'); });
    cycleZone.addEventListener('drop', (e) => {
      e.preventDefault();
      cycleZone.classList.remove('dragover');
      if (e.dataTransfer.files.length) {
        const fakeEvent = { target: { files: e.dataTransfer.files } };
        handleCycleDataUpload(fakeEvent);
      }
    });

    function handleFileUpload(event) {
      if (event.target.files.length) handleFile(event.target.files[0]);
    }

    function handleFile(file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(sheet);
        processAssignmentData(json);
      };
      reader.readAsArrayBuffer(file);
    }

    function processAssignmentData(data) {
      assignmentData = data.map(row => {
        const routeCode = row['ルートコード'] || '';
        const driverName = row['ドライバー名'] || '';
        const serviceType = row['配送サービスタイプ'] || '';
        const totalDeliveries = parseInt(row['合計配達数']) || 0;
        const allDestinations = parseInt(row['すべての目的地']) || 0;
        const routeDuration = parseInt(row['ルート所要時間']) || 0;
        const departureRaw = row['出発予定時刻'] || '';

        // Get driver capability from DB
        const driverInfo = findDriver(driverName);
        const capability = driverInfo ? driverInfo.packagesPerHour : null;

        // Calculate predicted end time
        const departure = parseDepartureTime(departureRaw);
        const predictedEnd = calculateEndTime(departure, allDestinations, capability, routeDuration);

        // Get area from cycle data, saved areas, or empty
        const area = routeAreas[routeCode] || (cycleData[routeCode] ? extractAreaFromAddresses(cycleData[routeCode]) : '');

        return {
          routeCode,
          driverName,
          serviceType,
          totalDeliveries,
          allDestinations,
          routeDuration,
          departure,
          departureRaw,
          capability,
          predictedEnd,
          area,
          status: getStatus(predictedEnd)
        };
      }).filter(r => r.routeCode); // Filter empty rows

      renderDashboard();
    }

    function findDriver(name) {
      if (!name) return null;
      // Direct match
      if (driverDB[name]) return driverDB[name];
      // Try reversing first/last name
      const parts = name.split(' ');
      if (parts.length === 2) {
        const reversed = parts[1] + ' ' + parts[0];
        if (driverDB[reversed]) return driverDB[reversed];
      }
      return null;
    }

    function parseDepartureTime(raw) {
      if (!raw) {
        const defaultTime = document.getElementById('default-departure')?.value || '09:00';
        return defaultTime;
      }
      // Handle formats like "09:07", "11:07"
      const match = raw.match(/(\d{1,2}):(\d{2})/);
      if (match) return `${match[1].padStart(2,'0')}:${match[2]}`;
      return '09:00';
    }

    function calculateEndTime(departure, packages, capability, amazonDuration) {
      const loadingTime = parseInt(document.getElementById('loading-time')?.value || '15');
      const travelOutbound = parseInt(document.getElementById('travel-outbound')?.value || '15');
      const travelReturn = parseInt(document.getElementById('travel-return')?.value || '15');
      let deliveryMinutes;

      if (capability && capability > 0) {
        // Use driver capability (packages/hour) — purely delivery time, no travel
        deliveryMinutes = (packages / capability) * 60;
      } else {
        // Fall back to Amazon's estimate (already includes travel)
        deliveryMinutes = amazonDuration;
      }

      // Total = loading + outbound travel + delivery work + return travel
      const totalMinutes = loadingTime + travelOutbound + deliveryMinutes + travelReturn;
      const [depH, depM] = departure.split(':').map(Number);
      const endMinutes = depH * 60 + depM + totalMinutes;
      const endH = Math.floor(endMinutes / 60);
      const endM = Math.round(endMinutes % 60);

      return `${String(endH).padStart(2,'0')}:${String(endM).padStart(2,'0')}`;
    }

    function getStatus(endTime) {
      if (!endTime) return 'unknown';
      const [h] = endTime.split(':').map(Number);
      if (h >= 21) return 'risk';
      if (h >= 19) return 'warning';
      return 'ok';
    }

    function renderDashboard() {
      document.getElementById('dashboard-content').classList.remove('hidden');
      document.getElementById('assign-status').textContent = `✓ ${assignmentData.length}ルート読込済み`;
      document.getElementById('assign-status').className = 'text-xs text-emerald-600 mt-1 font-medium';

      // Stats
      const totalRoutes = assignmentData.length;
      const totalDrivers = new Set(assignmentData.map(r => r.driverName).filter(Boolean)).size;
      const totalPackages = assignmentData.reduce((sum, r) => sum + r.totalDeliveries, 0);
      const latestEnd = assignmentData.reduce((latest, r) => {
        if (!r.predictedEnd) return latest;
        return r.predictedEnd > latest ? r.predictedEnd : latest;
      }, '00:00');

      document.getElementById('stat-routes').textContent = totalRoutes;
      document.getElementById('stat-drivers').textContent = totalDrivers;
      document.getElementById('stat-packages').textContent = totalPackages.toLocaleString();
      document.getElementById('stat-latest').textContent = latestEnd;

      // Table - sort by departure time → driver name → route code
      const sortedData = [...assignmentData].sort((a, b) =>
        (a.departure || '99:99').localeCompare(b.departure || '99:99') ||
        (a.driverName || '').localeCompare(b.driverName || '', 'ja') ||
        (a.routeCode || '').localeCompare(b.routeCode || '')
      );
      const tbody = document.getElementById('route-table-body');
      tbody.innerHTML = sortedData.map((route, i) => {
        const statusColor = route.status === 'risk' ? 'bg-accent' : route.status === 'warning' ? 'bg-yellow-400' : 'bg-emerald-400';
        const statusText = route.status === 'risk' ? '遅延リスク' : route.status === 'warning' ? '注意' : '正常';
        const capDisplay = route.capability ? route.capability.toFixed(1) : '<span class="text-ink-lighter">-</span>';
        const rowBg = i % 2 === 0 ? '' : 'bg-surface/50';
        const lineIcon = route.driverName ? '<svg class="w-4 h-4 flex-shrink-0 inline-block" viewBox="0 0 24 24" fill="#06C755"><path d="M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.627-.63h2.386c.349 0 .63.285.63.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.104.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.627-.63.349 0 .631.285.631.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.281.629-.629.629M12 1C5.373 1 0 5.373 0 12s5.373 11 12 11 12-4.373 12-11S18.627 1 12 1"/></svg>' : '';
        const originalIdx = assignmentData.indexOf(route);

        return `<tr class="border-b border-border hover:bg-accent-light/30 transition-colors ${rowBg}">
          <td class="px-4 py-2.5 text-sm"><span class="inline-flex items-center gap-1.5">${lineIcon}${route.driverName || '<span class="text-ink-lighter">未割当</span>'}</span></td>
          <td class="px-4 py-2.5 font-mono text-xs font-medium">${route.routeCode}</td>
          <td class="px-4 py-2.5 text-xs"><input type="text" value="${route.area || ''}" placeholder="クリックで入力" class="w-full bg-transparent border-b border-dashed border-border focus:border-accent focus:outline-none px-0 py-0.5 text-xs" onchange="updateArea(${originalIdx}, this.value)"></td>
          <td class="px-4 py-2.5 text-xs text-ink-light">${shortenService(route.serviceType)}</td>
          <td class="px-4 py-2.5 text-right font-mono text-sm font-medium">${route.totalDeliveries}</td>
          <td class="px-4 py-2.5 text-right font-mono text-sm">${route.allDestinations}</td>
          <td class="px-4 py-2.5 text-right font-mono text-sm">${capDisplay}</td>
          <td class="px-4 py-2.5 text-sm font-mono">${route.departure}</td>
          <td class="px-4 py-2.5 text-sm font-mono font-medium">${route.predictedEnd}</td>
          <td class="px-4 py-2.5">
            <span class="inline-flex items-center gap-1.5 text-xs">
              <span class="status-dot ${statusColor}"></span>
              ${statusText}
            </span>
          </td>
        </tr>`;
      }).join('');
    }

    function shortenService(service) {
      if (!service) return '-';
      if (service.includes('Biker')) return 'Biker';
      if (service.includes('AmFlex')) return 'Kei Van';
      if (service.includes('Standard')) return 'Standard';
      if (service.includes('Nursery')) return 'Nursery';
      return service.substring(0, 12);
    }

    // ===== Area Management =====
    let cycleData = {}; // routeCode -> array of addresses
    let routeAreas = JSON.parse(localStorage.getItem('routeAreas') || '{}');

    function updateArea(index, value) {
      assignmentData[index].area = value;
      // Save to localStorage for persistence
      routeAreas[assignmentData[index].routeCode] = value;
      localStorage.setItem('routeAreas', JSON.stringify(routeAreas));
    }

    // Extract area names from addresses in cycle data
    function extractAreaFromAddresses(addresses) {
      if (!addresses || addresses.length === 0) return '';

      // Parse addresses like "西区石丸3丁目39-11-3-201, 福岡市, 福岡"
      // or "早良区原3丁目, 福岡市, 福岡"
      // Extract: 区名 + 町名. Drop 福岡市 to save space.
      const neighborhoodCounts = {};

      addresses.forEach(addr => {
        if (!addr) return;

        // Remove 福岡市 prefix/suffix to normalize
        const normalized = addr.replace(/福岡市\s*/g, '');

        // Match patterns: X区Y町/X区Y (followed by number or comma)
        const match = normalized.match(/([\u4e00-\u9fff]+区)([\u4e00-\u9fff]+?)[\d丁,\s]/);
        if (match) {
          const ku = match[1]; // 区名 (e.g. "早良区")
          const machi = match[2]; // 町名 (e.g. "原")
          const key = machi;
          if (!neighborhoodCounts[key]) {
            neighborhoodCounts[key] = { count: 0, ku: ku };
          }
          neighborhoodCounts[key].count++;
        }
      });

      // Sort by frequency and get top neighborhoods
      const sorted = Object.entries(neighborhoodCounts)
        .sort((a, b) => b[1].count - a[1].count);

      if (sorted.length === 0) return '';

      // Get the primary ward (区)
      const primaryKu = sorted[0][1].ku;

      // Get top 3 neighborhoods from the same or nearby wards
      const topNames = sorted.slice(0, 3).map(([name, _]) => name);

      // Format: "早良区原・藤崎・昭代" style (福岡市 omitted)
      return primaryKu + topNames.join('・');
    }

    // ===== Driver Data Upload =====
    function handleDriverDataUpload(event) {
      if (!event.target.files.length) return;
      const file = event.target.files[0];
      const reader = new FileReader();
      reader.onload = (e) => {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(sheet);
        processDriverData(json);
      };
      reader.readAsArrayBuffer(file);
    }

    // ===== Cycle Data Upload (for area detection) =====
    function handleCycleDataUpload(event) {
      if (!event.target.files.length) return;
      const file = event.target.files[0];
      const reader = new FileReader();
      reader.onload = (e) => {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });

        // Each sheet is a route - extract addresses from each
        let routeCount = 0;
        workbook.SheetNames.forEach(sheetName => {
          const sheet = workbook.Sheets[sheetName];
          const json = XLSX.utils.sheet_to_json(sheet, { header: 1 });

          // First row contains "Route for XXXXX" - extract route code
          if (json.length > 0 && json[0] && json[0][0]) {
            const routeMatch = String(json[0][0]).match(/Route for\s+(\w+)/);
            if (routeMatch) {
              const routeCode = routeMatch[1].trim();

              // Column F (index 5) = "Actual Customer Address"
              // Start from row 3 (index 2) — row 1 is route name, row 2 is headers
              const addresses = [];
              for (let i = 2; i < json.length; i++) {
                const row = json[i];
                if (row && row[5] && String(row[5]).includes('区')) {
                  addresses.push(String(row[5]));
                }
              }

              if (addresses.length > 0) {
                cycleData[routeCode] = addresses;
                // Auto-extract area
                const area = extractAreaFromAddresses(addresses);
                if (area) routeAreas[routeCode] = area;
                routeCount++;
              }
            }
          }
        });

        localStorage.setItem('routeAreas', JSON.stringify(routeAreas));
        document.getElementById('cycle-status').textContent = `✓ ${routeCount}ルートのエリア情報読込済み`;
        document.getElementById('cycle-status').className = 'text-xs text-emerald-600 mt-1 font-medium';
        alert(`${routeCount}ルートのエリア情報を読み取りました`);

        // Re-render if dashboard is showing
        if (assignmentData.length) {
          assignmentData.forEach(r => {
            if (routeAreas[r.routeCode]) {
              r.area = routeAreas[r.routeCode];
            }
          });
          renderDashboard();
        }
      };
      reader.readAsArrayBuffer(file);
    }

    function processDriverData(data) {
      const today = new Date().toLocaleDateString('ja-JP');

      data.forEach(row => {
        const name = row['配達アソシエート'] || '';
        if (!name) return;

        const packagesPerHour = parseFloat(row['1時間あたり配送個数']) || null;
        // 列名に改行・空白が含まれる場合があるため、両方の空白を除去して部分一致検索
        const findCol = (keys, ...patterns) => {
          for (const p of patterns) {
            const pNorm = p.replace(/\s+/g, '');
            const key = keys.find(k => k.replace(/\s+/g, '').includes(pNorm));
            if (key && row[key] != null) return row[key];
          }
          return null;
        };
        const colKeys = Object.keys(row);
        const deliveryRateRaw = findCol(colKeys, '配管率%(平均)', '配管率%', '配管率');
        const deliveryRate = deliveryRateRaw != null ? parseFloat(String(deliveryRateRaw).replace('%', '')) : null;
        const workDaysRaw = findCol(colKeys, '集計対象稼働日数', '稼働日数');
        const workDays = workDaysRaw != null ? parseInt(workDaysRaw) : 0;
        const totalPkgRaw = findCol(colKeys, '配送個数合計', '配送個数');
        const totalPackages = totalPkgRaw != null ? parseInt(totalPkgRaw) : 0;
        const incidentRaw = findCol(colKeys, '正配依頼合計', '正配依頼');
        const incidents = incidentRaw != null ? parseInt(incidentRaw) : 0;
        const misRateRaw = findCol(colKeys, '誤配率%', '誤配率');
        // Excelの内部値は小数（例: 0.0076 = 0.76%）なので、1未満なら×100して%に変換
        let misdeliveryRate = misRateRaw != null ? parseFloat(String(misRateRaw).replace('%', '')) : null;
        if (misdeliveryRate != null && misdeliveryRate < 1 && misdeliveryRate > 0) { misdeliveryRate = Math.round(misdeliveryRate * 10000) / 100; }

        // If we already have data, calculate weighted average
        if (driverDB[name] && driverDB[name].packagesPerHour && packagesPerHour) {
          const existing = driverDB[name];
          const totalDays = existing.workDays + workDays;
          const weightedCapability = (existing.packagesPerHour * existing.workDays + packagesPerHour * workDays) / totalDays;

          driverDB[name] = {
            packagesPerHour: Math.round(weightedCapability * 10) / 10,
            deliveryRate: deliveryRate || existing.deliveryRate,
            misdeliveryRate: misdeliveryRate || existing.misdeliveryRate,
            workDays: totalDays,
            totalPackages: existing.totalPackages + totalPackages,
            incidents: existing.incidents + incidents,
            lastUpdated: today,
            history: [...(existing.history || []), { date: today, pph: packagesPerHour, days: workDays }]
          };
        } else {
          driverDB[name] = {
            packagesPerHour: packagesPerHour ? Math.round(packagesPerHour * 10) / 10 : null,
            deliveryRate,
            misdeliveryRate,
            workDays,
            totalPackages,
            incidents,
            lastUpdated: today,
            history: [{ date: today, pph: packagesPerHour, days: workDays }]
          };
        }
      });

      // Save to localStorage
      localStorage.setItem('driverDB', JSON.stringify(driverDB));
      renderDriverTable();

      // Re-calculate predictions if assignment data exists
      if (assignmentData.length) {
        processAssignmentData(assignmentData.map(r => ({
          'ルートコード': r.routeCode,
          'ドライバー名': r.driverName,
          '配送サービスタイプ': r.serviceType,
          '合計配達数': r.totalDeliveries,
          'すべての目的地': r.allDestinations,
          'ルート所要時間': r.routeDuration,
          '出発予定時刻': r.departureRaw
        })));
      }

      alert(`${Object.keys(driverDB).length}名のドライバーデータを更新しました`);
    }

    function renderDriverTable() {
      const tbody = document.getElementById('driver-table-body');
      const sorted = Object.entries(driverDB)
        .filter(([_, d]) => d.packagesPerHour)
        .sort((a, b) => (b[1].packagesPerHour || 0) - (a[1].packagesPerHour || 0));

      tbody.innerHTML = sorted.map(([name, d], i) => {
        const rowBg = i % 2 === 0 ? '' : 'bg-surface/50';
        const rateColor = d.deliveryRate >= 98 ? 'text-emerald-600' : d.deliveryRate >= 95 ? 'text-ink' : 'text-accent';
        const misRate = d.misdeliveryRate != null ? d.misdeliveryRate : (d.totalPackages > 0 ? Math.round(d.incidents / d.totalPackages * 10000) / 100 : null);
        const misRateColor = misRate != null ? (misRate <= 0.5 ? 'text-emerald-600' : misRate <= 1.0 ? 'text-ink' : 'text-accent') : '';
        const lineIcon = '<svg class="w-4 h-4 flex-shrink-0 inline-block" viewBox="0 0 24 24" fill="#06C755"><path d="M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.627-.63h2.386c.349 0 .63.285.63.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.104.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.627-.63.349 0 .631.285.631.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.281.629-.629.629M12 1C5.373 1 0 5.373 0 12s5.373 11 12 11 12-4.373 12-11S18.627 1 12 1"/></svg>';

        return `<tr class="border-b border-border hover:bg-accent-light/30 transition-colors ${rowBg}">
          <td class="px-4 py-2.5 text-sm font-medium"><span class="inline-flex items-center gap-1.5">${lineIcon}${name}</span></td>
          <td class="px-4 py-2.5 text-right font-mono text-sm font-medium">${d.packagesPerHour || '-'}</td>
          <td class="px-4 py-2.5 text-right font-mono text-sm ${rateColor}">${d.deliveryRate ? d.deliveryRate.toFixed(1) + '%' : '-'}</td>
          <td class="px-4 py-2.5 text-right font-mono text-sm ${misRateColor}">${misRate != null ? misRate.toFixed(2) + '%' : '-'}</td>
          <td class="px-4 py-2.5 text-right font-mono text-sm">${d.workDays}</td>
          <td class="px-4 py-2.5 text-right font-mono text-sm">${d.totalPackages.toLocaleString()}</td>
          <td class="px-4 py-2.5 text-right font-mono text-sm">${d.incidents}</td>
          <td class="px-4 py-2.5 text-xs text-ink-lighter">${d.lastUpdated || '-'}</td>
        </tr>`;
      }).join('');

      if (sorted.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="px-4 py-12 text-center text-sm text-ink-lighter">
          ドライバー実績データをアップロードしてください<br>
          <span class="text-xs">（ドライバー別配送データ.xlsx 形式）</span>
        </td></tr>`;
      }
    }

    // ===== Tenko (Roll Call) Management =====
    let tenkoSchedule = []; // { name, arrivalTime, arrivalMinutes, licenseAuth, mentorAuth }

    function handleShiftUpload(event) {
      if (!event.target.files.length) return;
      const file = event.target.files[0];
      const reader = new FileReader();
      reader.onload = (e) => {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        processShiftData(json);
      };
      reader.readAsArrayBuffer(file);
      event.target.value = '';
    }

    function processShiftData(rows) {
      if (rows.length < 6) { alert('シフトデータの形式が正しくありません'); return; }

      // Row4 (index 3) = header: find today's column
      const headerRow = rows[3];
      const today = new Date();
      const todayDay = today.getDate();
      const todayMonth = today.getMonth() + 1;

      let todayCol = -1;
      for (let c = 2; c < headerRow.length; c++) {
        const h = String(headerRow[c] || '');
        // Format: "日, 21/6月" or "月, 22/6月" — extract day/month
        const match = h.match(/(\d+)\/(\d+)月/);
        if (match) {
          const day = parseInt(match[1]);
          const month = parseInt(match[2]);
          if (day === todayDay && month === todayMonth) {
            todayCol = c;
            break;
          }
        }
      }

      if (todayCol === -1) {
        // Fallback: match by weekday index (日=0, 月=1, ..., 土=6)
        const weekdayMap = { '日': 0, '月': 1, '火': 2, '水': 3, '木': 4, '金': 5, '土': 6 };
        const todayWeekday = today.getDay();
        for (let c = 2; c < headerRow.length; c++) {
          const h = String(headerRow[c] || '');
          const firstChar = h.charAt(0);
          if (weekdayMap[firstChar] === todayWeekday) {
            todayCol = c;
            break;
          }
        }
      }

      if (todayCol === -1) {
        alert('本日の日付に一致するシフト列が見つかりませんでした。\nヘッダー: ' + headerRow.slice(2).join(', '));
        return;
      }

      // Parse drivers from Row6 onward (index 5+)
      tenkoSchedule = [];
      for (let r = 5; r < rows.length; r++) {
        const name = String(rows[r]?.[0] || '').trim();
        if (!name || name === '全記載') continue;
        const cellValue = String(rows[r]?.[todayCol] || '').trim();
        if (!cellValue) continue; // Not working today

        // Parse arrival time from cell: "Standard Parcel\n11:00午前 • 6時間 30 m"
        const arrivalTime = parseArrivalTime(cellValue);
        if (!arrivalTime) continue;

        tenkoSchedule.push({
          name: name,
          arrivalTime: arrivalTime.display,
          arrivalMinutes: arrivalTime.minutes,
          licenseAuth: false,
          mentorAuth: false
        });
      }

      // Sort by arrival time
      tenkoSchedule.sort((a, b) => a.arrivalMinutes - b.arrivalMinutes);

      // Save to localStorage
      const todayStr = today.toISOString().slice(0, 10);
      localStorage.setItem('tenkoDate', todayStr);
      localStorage.setItem('tenkoSchedule', JSON.stringify(tenkoSchedule));

      renderTenkoTable();
    }

    function parseArrivalTime(cellText) {
      // Match patterns like "11:00午前" or "2:40午後"
      const lines = cellText.split(/\n/);
      for (const line of lines) {
        const match = line.match(/(\d{1,2}):(\d{2})\s*(午前|午後)/);
        if (match) {
          let hours = parseInt(match[1]);
          const mins = parseInt(match[2]);
          const ampm = match[3];
          if (ampm === '午後' && hours < 12) hours += 12;
          if (ampm === '午前' && hours === 12) hours = 0;
          const display = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
          return { display, minutes: hours * 60 + mins };
        }
      }
      return null;
    }

    function toggleAuth(index, type) {
      if (index < 0 || index >= tenkoSchedule.length) return;
      if (type === 'license') tenkoSchedule[index].licenseAuth = !tenkoSchedule[index].licenseAuth;
      if (type === 'mentor') tenkoSchedule[index].mentorAuth = !tenkoSchedule[index].mentorAuth;
      const todayStr = new Date().toISOString().slice(0, 10);
      localStorage.setItem('tenkoSchedule', JSON.stringify(tenkoSchedule));
      renderTenkoTable();
    }

    function resetTenkoStatus() {
      if (!confirm('全ドライバーの認証状態をリセットしますか？')) return;
      tenkoSchedule.forEach(d => { d.licenseAuth = false; d.mentorAuth = false; });
      localStorage.setItem('tenkoSchedule', JSON.stringify(tenkoSchedule));
      renderTenkoTable();
    }

    function forceComplete(index) {
      if (index < 0 || index >= tenkoSchedule.length) return;
      tenkoSchedule[index].licenseAuth = true;
      tenkoSchedule[index].mentorAuth = true;
      localStorage.setItem('tenkoSchedule', JSON.stringify(tenkoSchedule));
      renderTenkoTable();
    }

    function undoComplete(index) {
      if (index < 0 || index >= tenkoSchedule.length) return;
      tenkoSchedule[index].licenseAuth = false;
      tenkoSchedule[index].mentorAuth = false;
      localStorage.setItem('tenkoSchedule', JSON.stringify(tenkoSchedule));
      renderTenkoTable();
    }

    // ===== Camera License Authentication =====
    let cameraStream = null;
    let cameraDriverIndex = -1;
    let cameraAuthType = 'license'; // 'license' or 'mentor'

    // Sound effects using Web Audio API
    function playSound(type) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (type === 'success') {
        // Single chime for license auth
        [523, 659].forEach((freq, i) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.3, ctx.currentTime + i * 0.15);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.4);
          osc.connect(gain).connect(ctx.destination);
          osc.start(ctx.currentTime + i * 0.15);
          osc.stop(ctx.currentTime + i * 0.15 + 0.4);
        });
      } else if (type === 'complete') {
        // Triumphant 3-note chime for both complete
        [523, 659, 784].forEach((freq, i) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.35, ctx.currentTime + i * 0.2);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.2 + 0.6);
          osc.connect(gain).connect(ctx.destination);
          osc.start(ctx.currentTime + i * 0.2);
          osc.stop(ctx.currentTime + i * 0.2 + 0.6);
        });
      } else if (type === 'error') {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = 200;
        gain.gain.setValueAtTime(0.2, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
        osc.connect(gain).connect(ctx.destination);
        osc.start(); osc.stop(ctx.currentTime + 0.5);
      }
    }

    function openLicenseCamera(index) {
      const d = tenkoSchedule[index];
      if (!d) return;
      // Determine which auth to do next
      if (!d.licenseAuth) {
        cameraAuthType = 'license';
      } else if (!d.mentorAuth) {
        cameraAuthType = 'mentor';
      } else return;

      cameraDriverIndex = index;
      const modal = document.getElementById('camera-modal');
      document.getElementById('camera-driver-name').textContent = d.name;
      document.getElementById('camera-auth-type').textContent = cameraAuthType === 'license' ? '📷 QRコードをかざしてください' : '📱 メンター起動画面をかざしてください';
      document.getElementById('camera-confirm-btn').textContent = cameraAuthType === 'license' ? 'QR 認証OK' : 'メンター 認証OK';
      document.getElementById('camera-result').textContent = '';
      document.getElementById('camera-result').className = 'text-sm mt-2';
      modal.classList.remove('hidden');

      var confirmBtn = document.getElementById('camera-confirm-btn');
      confirmBtn.disabled = false;
      if (cameraAuthType === 'license') {
        confirmBtn.className = 'flex-1 py-3 rounded-lg text-sm font-bold bg-emerald-500 text-white hover:bg-emerald-600 transition-colors text-lg';
      } else {
        confirmBtn.className = 'flex-1 py-3 rounded-lg text-sm font-bold bg-purple-500 text-white hover:bg-purple-600 transition-colors text-lg';
      }

      var video = document.getElementById('camera-video');
      // USBカメラ優先: USB → 内蔵 → その他
      selectBestCamera().then(function(deviceId) {
        var constraints = { video: { width: { ideal: 1280 }, height: { ideal: 720 } } };
        if (deviceId) {
          constraints.video.deviceId = { exact: deviceId };
        }
        return navigator.mediaDevices.getUserMedia(constraints);
      })
        .then(function(stream) {
          cameraStream = stream;
          video.srcObject = stream;
          video.play();
        })
        .catch(function(err) {
          document.getElementById('camera-result').textContent = 'カメラの起動に失敗しました: ' + err.message;
          document.getElementById('camera-result').className = 'text-sm mt-2 text-red-500';
        });
    }

    // USBカメラ優先選択: USB → 内蔵 → その他デバイス
    function selectBestCamera() {
      return navigator.mediaDevices.enumerateDevices().then(function(devices) {
        var videoDevices = devices.filter(function(d) { return d.kind === 'videoinput'; });
        if (videoDevices.length === 0) return null;

        // USBカメラを探す（ラベルにUSB/Webcam/外付けなどが含まれる）
        var usbCamera = null;
        var builtinCamera = null;
        var otherCamera = null;

        for (var i = 0; i < videoDevices.length; i++) {
          var label = (videoDevices[i].label || '').toLowerCase();
          if (label.indexOf('usb') >= 0 || label.indexOf('webcam') >= 0 || label.indexOf('external') >= 0 || label.indexOf('logitech') >= 0 || label.indexOf('buffalo') >= 0 || label.indexOf('elecom') >= 0) {
            if (!usbCamera) usbCamera = videoDevices[i];
          } else if (label.indexOf('integrated') >= 0 || label.indexOf('built') >= 0 || label.indexOf('internal') >= 0 || label.indexOf('front') >= 0 || label.indexOf('back') >= 0 || label.indexOf('facing') >= 0) {
            if (!builtinCamera) builtinCamera = videoDevices[i];
          } else {
            if (!otherCamera) otherCamera = videoDevices[i];
          }
        }

        // 優先順: USB → 内蔵 → その他 → リスト最初
        var selected = usbCamera || builtinCamera || otherCamera || videoDevices[0];
        console.log('カメラ選択:', selected.label || '(ラベルなし)', '| 全デバイス:', videoDevices.map(function(d) { return d.label || d.deviceId; }).join(', '));
        return selected.deviceId;
      }).catch(function() {
        return null;
      });
    }

    function closeCameraModal() {
      document.getElementById('camera-modal').classList.add('hidden');
      if (cameraStream) {
        cameraStream.getTracks().forEach(t => t.stop());
        cameraStream = null;
      }
      document.getElementById('camera-video').srcObject = null;
      cameraDriverIndex = -1;
    }

    function confirmCameraAuth() {
      var d = tenkoSchedule[cameraDriverIndex];
      if (!d) return;
      var resultEl = document.getElementById('camera-result');
      var confirmBtn = document.getElementById('camera-confirm-btn');

      // 二重押し防止
      if (confirmBtn.disabled) return;

      if (cameraAuthType === 'license') {
        d.licenseAuth = true;
        localStorage.setItem('tenkoSchedule', JSON.stringify(tenkoSchedule));

        if (d.mentorAuth) {
          resultEl.textContent = '✅ QR認証OK → 両方完了！';
          resultEl.className = 'text-sm mt-2 text-emerald-600 font-bold';
          playSound('complete');
          confirmBtn.disabled = true;
          setTimeout(function() { closeCameraModal(); renderTenkoTable(); }, 1500);
        } else {
          resultEl.textContent = '✅ QR認証OK → 続いてメンター認証へ';
          resultEl.className = 'text-sm mt-2 text-emerald-600 font-bold';
          playSound('success');
          confirmBtn.disabled = true;
          setTimeout(function() {
            cameraAuthType = 'mentor';
            document.getElementById('camera-auth-type').textContent = '📱 メンター起動画面をかざしてください';
            confirmBtn.textContent = 'メンター 認証OK';
            confirmBtn.disabled = false;
            confirmBtn.className = 'flex-1 py-3 rounded-lg text-sm font-bold bg-purple-500 text-white hover:bg-purple-600 transition-colors text-lg';
            resultEl.textContent = 'メンターアプリの「ルート終了」画面をカメラに見せてください';
            resultEl.className = 'text-sm mt-2 text-purple-600 font-medium';
          }, 1500);
        }
      } else if (cameraAuthType === 'mentor') {
        d.mentorAuth = true;
        localStorage.setItem('tenkoSchedule', JSON.stringify(tenkoSchedule));
        resultEl.textContent = '🎉 メンター認証OK — 点呼完了！';
        resultEl.className = 'text-sm mt-2 text-emerald-600 font-bold text-lg';
        playSound('complete');
        confirmBtn.disabled = true;
        setTimeout(function() { closeCameraModal(); renderTenkoTable(); }, 1500);
      }
    }

    function renderTenkoTable() {
      const tbody = document.getElementById('tenko-table-body');
      const emptyEl = document.getElementById('tenko-empty');

      if (tenkoSchedule.length === 0) {
        tbody.innerHTML = '';
        emptyEl.classList.remove('hidden');
        document.getElementById('tenko-total').textContent = '-';
        document.getElementById('tenko-done').textContent = '0';
        document.getElementById('tenko-progress').textContent = '0';
        document.getElementById('tenko-pending').textContent = '0';
        return;
      }

      emptyEl.classList.add('hidden');
      const now = new Date();
      const nowMinutes = now.getHours() * 60 + now.getMinutes();

      let done = 0, progress = 0, pending = 0;

      tbody.innerHTML = tenkoSchedule.map((d, i) => {
        const bothDone = d.licenseAuth && d.mentorAuth;
        const oneDone = d.licenseAuth || d.mentorAuth;
        let status, statusClass;
        if (bothDone) { status = '完了'; statusClass = 'text-emerald-600 font-medium'; done++; }
        else if (oneDone) {
          status = d.licenseAuth ? 'メンター待ち' : 'QR待ち';
          statusClass = 'text-amber-500 font-medium'; progress++;
        }
        else { status = '未開始'; statusClass = 'text-ink-lighter'; pending++; }

        const overdue = !bothDone && nowMinutes >= d.arrivalMinutes;
        const rowBg = overdue ? 'bg-red-50' : (i % 2 === 0 ? '' : 'bg-surface/50');
        const overdueIcon = overdue ? ' <span class="text-accent text-xs font-bold">⚠ 超過</span>' : '';

        // 🟢 = 認証済み, 🔴 = 待ち(片方認証済み), ⚪ = 未開始
        const licDot = d.licenseAuth
          ? `<button onclick="toggleAuth(${i},'license')" class="inline-flex items-center gap-1 cursor-pointer hover:opacity-70"><span class="inline-block w-3 h-3 rounded-full bg-emerald-500"></span><span class="text-xs text-emerald-600">済</span></button>`
          : `<button onclick="toggleAuth(${i},'license')" class="inline-flex items-center gap-1 cursor-pointer hover:opacity-70"><span class="inline-block w-3 h-3 rounded-full ${oneDone ? 'bg-red-500' : 'bg-gray-300'}"></span><span class="text-xs ${oneDone ? 'text-red-500' : 'text-ink-lighter'}">${oneDone ? '待ち' : '未'}</span></button>`;

        const menDot = d.mentorAuth
          ? `<button onclick="toggleAuth(${i},'mentor')" class="inline-flex items-center gap-1 cursor-pointer hover:opacity-70"><span class="inline-block w-3 h-3 rounded-full bg-emerald-500"></span><span class="text-xs text-emerald-600">済</span></button>`
          : `<button onclick="toggleAuth(${i},'mentor')" class="inline-flex items-center gap-1 cursor-pointer hover:opacity-70"><span class="inline-block w-3 h-3 rounded-full ${oneDone ? 'bg-red-500' : 'bg-gray-300'}"></span><span class="text-xs ${oneDone ? 'text-red-500' : 'text-ink-lighter'}">${oneDone ? '待ち' : '未'}</span></button>`;

        const forceBtn = bothDone
          ? `<button onclick="undoComplete(${i})" class="px-2 py-1 rounded text-xs font-medium bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors" title="認証を戻す">戻す</button>`
          : `<button onclick="forceComplete(${i})" class="px-2 py-1 rounded text-xs font-medium bg-amber-100 text-amber-700 hover:bg-amber-200 transition-colors" title="強制完了">強制</button>`;

        const cameraBtn = bothDone
          ? ''
          : `<button onclick="openLicenseCamera(${i})" class="px-2 py-1 rounded text-xs font-medium bg-blue-100 text-blue-700 hover:bg-blue-200 transition-colors ml-1" title="カメラ認証">📷</button>`;

        return `<tr class="border-b border-border hover:bg-accent-light/30 transition-colors ${rowBg}">
          <td class="px-4 py-2.5 text-sm font-medium">${d.name}</td>
          <td class="px-4 py-2.5 text-center text-sm font-mono">${d.arrivalTime}${overdueIcon}</td>
          <td class="px-4 py-2.5 text-center">${licDot}</td>
          <td class="px-4 py-2.5 text-center">${menDot}</td>
          <td class="px-4 py-2.5 text-center ${statusClass}">${status}</td>
          <td class="px-4 py-2.5 text-center">${forceBtn}${cameraBtn}</td>
        </tr>`;
      }).join('');

      // Update summary cards
      document.getElementById('tenko-total').textContent = tenkoSchedule.length;
      document.getElementById('tenko-done').textContent = done;
      document.getElementById('tenko-progress').textContent = progress;
      document.getElementById('tenko-pending').textContent = pending;
    }

    // Load saved tenko data on startup
    function loadTenkoData() {
      const todayStr = new Date().toISOString().slice(0, 10);
      const savedDate = localStorage.getItem('tenkoDate');
      if (savedDate === todayStr) {
        const saved = localStorage.getItem('tenkoSchedule');
        if (saved) {
          try { tenkoSchedule = JSON.parse(saved); } catch(e) { tenkoSchedule = []; }
          renderTenkoTable();
        }
      } else {
        // Different day — clear old data
        localStorage.removeItem('tenkoSchedule');
        localStorage.removeItem('tenkoDate');
      }
    }

    // Auto-refresh overdue highlights every minute
    setInterval(() => {
      if (tenkoSchedule.length > 0 && currentTab === 'tenko') renderTenkoTable();
    }, 60000);

    // ===== Auto Scan Mode =====
    let autoScanActive = false;
    let html5QrCode = null;
    let ocrScanning = false;
    let currentScanPhase = 'qr'; // 'qr' or 'ocr'
    let lastQrDriver = null;
    let ocrStream = null;
    let ocrInterval = null;
    let tesseractWorker = null;

    function addScanLog(message, type) {
      const log = document.getElementById('scan-log-entries');
      const time = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const color = type === 'success' ? 'text-emerald-600' : type === 'error' ? 'text-red-500' : type === 'warn' ? 'text-amber-600' : 'text-ink-lighter';
      log.innerHTML = `<div class="${color}"><span class="text-gray-400">${time}</span> ${message}</div>` + log.innerHTML;
    }

    async function toggleAutoScan() {
      if (autoScanActive) {
        stopAutoScan();
      } else {
        startAutoScan();
      }
    }

    async function startAutoScan() {
      if (tenkoSchedule.length === 0) {
        alert('先にシフトデータを読み込んでください');
        return;
      }
      autoScanActive = true;
      currentScanPhase = 'qr';
      lastQrDriver = null;
      document.getElementById('auto-scan-panel').classList.remove('hidden');
      document.getElementById('auto-scan-btn').textContent = '⏹ 自動認証を停止';
      document.getElementById('auto-scan-btn').className = 'text-xs px-4 py-1.5 rounded font-bold bg-red-500 text-white hover:bg-red-600 transition-colors';
      document.getElementById('scan-log-entries').innerHTML = '';
      addScanLog('自動認証モード開始', 'info');
      updateScanStatus('qr');
      startQrScan();
    }

    function stopAutoScan() {
      autoScanActive = false;
      document.getElementById('auto-scan-btn').textContent = '🔄 自動認証モード';
      document.getElementById('auto-scan-btn').className = 'text-xs px-4 py-1.5 rounded font-bold bg-blue-500 text-white hover:bg-blue-600 transition-colors';
      stopQrScan();
      stopOcrScan();
      document.getElementById('auto-scan-panel').classList.add('hidden');
      addScanLog('自動認証モード停止', 'info');
    }

    function updateScanStatus(phase, driverName) {
      const title = document.getElementById('scan-status-title');
      const detail = document.getElementById('scan-status-detail');
      const badge = document.getElementById('scan-driver-badge');
      if (phase === 'qr') {
        title.textContent = '📷 QRコードをかざしてください';
        title.className = 'text-base font-bold text-blue-600';
        detail.textContent = '登録済みQRコードをカメラに向けてください';
        badge.classList.add('hidden');
      } else if (phase === 'ocr') {
        title.textContent = '📱 メンター起動画面をかざしてください';
        title.className = 'text-base font-bold text-amber-600';
        detail.textContent = '「ルート終了」の表示がある画面をカメラに向けてください';
        badge.textContent = driverName;
        badge.classList.remove('hidden');
      } else if (phase === 'complete') {
        title.textContent = '✅ 認証完了！次のドライバーのQRをかざしてください';
        title.className = 'text-base font-bold text-emerald-600';
        detail.textContent = '';
        badge.classList.add('hidden');
      }
    }

    // --- QR Code Scanning ---
    function startQrScan() {
      stopOcrScan();
      document.getElementById('qr-reader').classList.remove('hidden');
      document.getElementById('ocr-preview').classList.add('hidden');
      try {
        html5QrCode = new Html5Qrcode('qr-reader');
        selectBestCamera().then(function(deviceId) {
          var videoConst = { width: { ideal: 1280 }, height: { ideal: 720 }, aspectRatio: { ideal: 1.333 }, focusMode: 'continuous' };
          if (deviceId) {
            videoConst.deviceId = { exact: deviceId };
          }
          return html5QrCode.start(
            deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' },
            { fps: 15, qrbox: { width: 300, height: 300 }, disableFlip: false },
            onQrCodeScanned,
            function() {}
          );
        }).catch(function(err) {
          addScanLog('カメラ起動失敗: ' + err.message, 'error');
        });
      } catch (e) {
        addScanLog('QRスキャナー初期化失敗: ' + e.message, 'error');
      }
    }

    function stopQrScan() {
      if (html5QrCode) {
        html5QrCode.stop().then(function() {
          if (html5QrCode) {
            html5QrCode.clear();
            html5QrCode = null;
          }
        }).catch(function() {
          html5QrCode = null;
        });
      }
    }

    function onQrCodeScanned(decodedText) {
      var driverName = findDriverByQr(decodedText);

      if (!driverName) {
        addScanLog('不明なQRコード: ' + decodedText.slice(0, 30), 'warn');
        return;
      }

      var matchedIndex = findTenkoDriver(driverName);

      // シフト外なら臨時点呼として自動追加
      if (matchedIndex < 0) {
        tenkoSchedule.push({
          name: driverName,
          arrivalTime: '臨時',
          arrivalMinutes: 9999,
          licenseAuth: false,
          mentorAuth: false,
          temporary: true
        });
        matchedIndex = tenkoSchedule.length - 1;
        localStorage.setItem('tenkoSchedule', JSON.stringify(tenkoSchedule));
        renderTenkoTable();
        addScanLog('🟠 臨時点呼追加：' + driverName, 'info');
      }

      var d = tenkoSchedule[matchedIndex];
      if (d.licenseAuth && d.mentorAuth) {
        addScanLog(driverName + ' — 既に完了済み', 'info');
        return;
      }

      if (!d.licenseAuth) {
        d.licenseAuth = true;
        localStorage.setItem('tenkoSchedule', JSON.stringify(tenkoSchedule));
        renderTenkoTable();
        playSound('success');
        addScanLog('✅ ' + driverName + ' — QR認証OK', 'success');

        lastQrDriver = { name: driverName, index: matchedIndex };
        currentScanPhase = 'ocr';
        updateScanStatus('ocr', driverName);
        stopQrScan();
        startOcrScan(matchedIndex);
      }
    }

    function findDriverByQr(decodedText) {
      // OFK3_LICENSE: 形式
      if (decodedText.indexOf('OFK3_LICENSE:') === 0) {
        return decodedText.replace('OFK3_LICENSE:', '').trim();
      }

      // OFK3_DRIVER: 形式
      if (decodedText.indexOf('OFK3_DRIVER:') === 0) {
        return decodedText.replace('OFK3_DRIVER:', '').trim();
      }

      // OFK3_D0001 形式（自動生成ID）
      // 注意：driverDBの並び順に依存するため、長期運用では推奨されません
      // 新規発行は OFK3_DRIVER:名前 の形式を推奨します
      if (decodedText.indexOf('OFK3_D') === 0 && decodedText.length <= 12) {
        var keys = Object.keys(driverDB).sort();
        var idx = parseInt(decodedText.replace('OFK3_D', ''), 10);
        if (idx > 0 && idx <= keys.length) {
          return keys[idx - 1];
        }
      }

      // Transport ID で照合
      var clean = decodedText.replace(/[\s\-]/g, '');
      for (var name in transportIDs) {
        if (!transportIDs[name]) continue;
        if (clean === transportIDs[name].toString().replace(/[\s\-]/g, '')) {
          return name;
        }
      }

      return null;
    }

    // ファジーマッチ: スペース・全角半角を無視して点呼スケジュールから検索
    function findTenkoDriver(name) {
      var clean = name.replace(/[\s　]/g, '');
      for (var i = 0; i < tenkoSchedule.length; i++) {
        if (tenkoSchedule[i].name === name) return i;
        if (tenkoSchedule[i].name.replace(/[\s　]/g, '') === clean) return i;
      }
      return -1;
    }

    // --- OCR Mentor Screen Scanning ---
    async function startOcrScan(driverIndex) {
      document.getElementById('qr-reader').classList.add('hidden');
      var ocrPreview = document.getElementById('ocr-preview');
      ocrPreview.classList.remove('hidden');
      ocrPreview.style.display = 'block';

      const video = document.getElementById('ocr-display-video');
      try {
        var bestDeviceId = await selectBestCamera();
        var constraints = { video: { width: { ideal: 1280 }, height: { ideal: 720 } } };
        if (bestDeviceId) {
          constraints.video.deviceId = { exact: bestDeviceId };
        }
        ocrStream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = ocrStream;
        video.play();
      } catch (err) {
        addScanLog('カメラ起動失敗: ' + err.message, 'error');
        return;
      }

      addScanLog('📱 メンター画面スキャン中...', 'info');

      // Initialize Tesseract worker if needed
      if (!tesseractWorker) {
        addScanLog('OCRエンジン初期化中...（初回のみ時間がかかります）', 'info');
        tesseractWorker = await Tesseract.createWorker('jpn', 1, {
          logger: () => {}
        });
        addScanLog('OCRエンジン準備完了', 'success');
      }

      ocrScanning = true;
      runOcrLoop(driverIndex);
    }

    async function runOcrLoop(driverIndex) {
      if (!ocrScanning || !autoScanActive) return;

      var video = document.getElementById('ocr-display-video');
      var canvas = document.getElementById('ocr-canvas');

      var vw = video.videoWidth || 1280;
      var vh = video.videoHeight || 720;
      canvas.width = vw;
      canvas.height = vh;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, vw, vh);

      // 「ルート終了」ボタンの領域（画面中央〜下部）
      var cropX = Math.floor(vw * 0.1);
      var cropY = Math.floor(vh * 0.3);
      var cropW = Math.floor(vw * 0.8);
      var cropH = Math.floor(vh * 0.4);

      var imgData = ctx.getImageData(cropX, cropY, cropW, cropH);
      var pixels = imgData.data;

      // 紫色ピクセルをカウント（Mentorの「ルート終了」ボタンの色）
      var purpleCount = 0;
      var totalPixels = cropW * cropH;

      for (var i = 0; i < pixels.length; i += 4) {
        var r = pixels[i];
        var g = pixels[i + 1];
        var b = pixels[i + 2];

        // 紫〜青紫の範囲を広めに取る
        if (r >= 50 && r <= 200 && g >= 10 && g <= 130 && b >= 90 && b <= 255 && b > r * 0.6 && b > g * 1.2) {
          purpleCount++;
        }
      }

      var purpleRatio = purpleCount / totalPixels;
      var percentText = (purpleRatio * 100).toFixed(1);

      if (purpleRatio >= 0.08) {
        // 紫色が8%以上 → 「ルート終了」ボタンが表示されている
        ocrScanning = false;
        var d = tenkoSchedule[driverIndex];
        d.mentorAuth = true;
        localStorage.setItem('tenkoSchedule', JSON.stringify(tenkoSchedule));
        renderTenkoTable();
        playSound('complete');
        addScanLog('🎉 ' + d.name + ' — メンター認証OK（紫検出' + percentText + '%）→ 点呼完了！', 'success');

        stopOcrScan();
        updateScanStatus('complete');
        setTimeout(function() {
          if (autoScanActive) {
            currentScanPhase = 'qr';
            updateScanStatus('qr');
            startQrScan();
          }
        }, 2000);
        return;
      } else {
        if (purpleRatio >= 0.03) {
          addScanLog('紫検出' + percentText + '% — もう少し近づけてください', 'info');
        }
        if (ocrScanning) setTimeout(function() { runOcrLoop(driverIndex); }, 800);
      }
    }

    function stopOcrScan() {
      ocrScanning = false;
      if (ocrStream) {
        ocrStream.getTracks().forEach(t => t.stop());
        ocrStream = null;
      }
      const video = document.getElementById('ocr-display-video');
      if (video) video.srcObject = null;
    }

    // ===== Optimization =====
    function runOptimization() {
      if (!assignmentData.length) {
        alert('先にアサインデータをアップロードしてください');
        return;
      }
      if (Object.keys(driverDB).length === 0) {
        alert('先にドライバー実績データをアップロードしてください');
        return;
      }

      const results = generateOptimizationSuggestions();
      renderOptimizationResults(results);
    }

    function generateOptimizationSuggestions() {
      const suggestions = [];

      // Sort routes by package count (heavy first)
      const sortedRoutes = [...assignmentData].sort((a, b) => b.totalDeliveries - a.totalDeliveries);

      // Sort available drivers by capability (fast first)
      const availableDrivers = Object.entries(driverDB)
        .filter(([_, d]) => d.packagesPerHour)
        .sort((a, b) => b[1].packagesPerHour - a[1].packagesPerHour);

      // Current assignment analysis
      sortedRoutes.forEach(route => {
        if (!route.driverName) return;
        const driverInfo = findDriver(route.driverName);
        if (!driverInfo) return;

        // Check if there's a better match
        const currentEfficiency = driverInfo.packagesPerHour;
        const hoursNeeded = route.totalDeliveries / currentEfficiency;

        // Find if a faster driver is on a lighter route
        const lighterRoutes = sortedRoutes.filter(r =>
          r.routeCode !== route.routeCode &&
          r.totalDeliveries < route.totalDeliveries * 0.7 &&
          r.driverName
        );

        lighterRoutes.forEach(lighterRoute => {
          const lighterDriverInfo = findDriver(lighterRoute.driverName);
          if (!lighterDriverInfo) return;

          if (lighterDriverInfo.packagesPerHour > currentEfficiency * 1.2) {
            // Faster driver is on a lighter route — suggest swap
            const currentEnd = route.predictedEnd;
            const swappedHours = route.totalDeliveries / lighterDriverInfo.packagesPerHour;
            const [depH, depM] = route.departure.split(':').map(Number);
            const loadingTime = parseInt(document.getElementById('loading-time')?.value || '15');
            const newEndMinutes = depH * 60 + depM + (swappedHours * 60) + loadingTime;
            const newEnd = `${String(Math.floor(newEndMinutes/60)).padStart(2,'0')}:${String(Math.round(newEndMinutes%60)).padStart(2,'0')}`;

            suggestions.push({
              type: 'swap',
              route1: route.routeCode,
              driver1: route.driverName,
              route2: lighterRoute.routeCode,
              driver2: lighterRoute.driverName,
              currentEnd,
              optimizedEnd: newEnd,
              improvement: calculateTimeDiff(currentEnd, newEnd),
              reason: `${lighterRoute.driverName}（${lighterDriverInfo.packagesPerHour}個/h）は${route.driverName}（${currentEfficiency}個/h）より高速。重いルートに再配置で${calculateTimeDiff(currentEnd, newEnd)}分短縮可能`
            });
          }
        });
      });

      // Deduplicate and sort by improvement
      const seen = new Set();
      return suggestions
        .filter(s => {
          const key = `${s.driver1}-${s.driver2}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => b.improvement - a.improvement)
        .slice(0, 5);
    }

    function calculateTimeDiff(time1, time2) {
      const [h1, m1] = time1.split(':').map(Number);
      const [h2, m2] = time2.split(':').map(Number);
      return (h1 * 60 + m1) - (h2 * 60 + m2);
    }

    function renderOptimizationResults(suggestions) {
      const container = document.getElementById('optimization-results');
      const empty = document.getElementById('optimization-empty');

      if (suggestions.length === 0) {
        container.classList.add('hidden');
        empty.classList.remove('hidden');
        empty.innerHTML = '<p class="text-sm text-ink-lighter text-center py-16">現在のアサインは概ね最適です。大幅な改善提案はありません。</p>';
        return;
      }

      empty.classList.add('hidden');
      container.classList.remove('hidden');

      container.innerHTML = `
        <div class="space-y-3">
          ${suggestions.map((s, i) => `
            <div class="card p-4 fade-in" style="animation-delay: ${i * 0.1}s">
              <div class="flex items-start justify-between">
                <div class="flex-1">
                  <div class="flex items-center gap-2 mb-2">
                    <span class="optimization-badge">提案 ${i + 1}</span>
                    <span class="text-xs text-emerald-600 font-medium">-${s.improvement}分</span>
                  </div>
                  <p class="text-sm text-ink mb-2">${s.reason}</p>
                  <div class="flex items-center gap-4 text-xs text-ink-light">
                    <span>${s.route1}: ${s.driver1} → ${s.driver2}</span>
                    <span class="text-ink-lighter">|</span>
                    <span>${s.route2}: ${s.driver2} → ${s.driver1}</span>
                  </div>
                </div>
                <div class="text-right ml-4">
                  <p class="text-xs text-ink-lighter">終了予測</p>
                  <p class="text-sm font-mono"><span class="line-through text-ink-lighter">${s.currentEnd}</span> → <span class="font-medium text-emerald-600">${s.optimizedEnd}</span></p>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      `;
    }

    function closeModal() {
      document.getElementById('line-modal').classList.add('hidden');
    }

    function showSettings() {
      document.getElementById('settings-modal').classList.remove('hidden');
    }

    function closeSettings() {
      document.getElementById('settings-modal').classList.add('hidden');
      saveLineSettings();
    }

    // ===== Master Management =====
    let lineMapping = JSON.parse(localStorage.getItem('lineMapping') || '{}');
    let masterNotes = JSON.parse(localStorage.getItem('masterNotes') || '{}');
    let phoneMapping = JSON.parse(localStorage.getItem('phoneMapping') || '{}');
    let transportIDs = JSON.parse(localStorage.getItem('transportIDs') || '{}');
    let driverDepartments = JSON.parse(localStorage.getItem('driverDepartments') || '{}');
    let driverJapaneseNames = JSON.parse(localStorage.getItem('driverJapaneseNames') || '{}');
    const DEPARTMENTS = ['GDSダイレクト', 'GDS管理', 'GDSパート', 'JHS', 'AE物流', 'ファンタジスタ', 'LINGｓ', 'OFK6'];

    // LINE profile cache: { userId: { displayName, pictureUrl, statusMessage, fetchedAt } }
    let lineProfileCache = JSON.parse(localStorage.getItem('lineProfileCache') || '{}');

    // 24-hour cache threshold in ms
    var PROFILE_CACHE_TTL = 24 * 60 * 60 * 1000;

    // Pre-register admin
    if (!lineMapping['前原雷蔵']) { lineMapping['前原雷蔵'] = 'raizo0428gion'; localStorage.setItem('lineMapping', JSON.stringify(lineMapping)); }
    if (!phoneMapping['前原雷蔵']) { phoneMapping['前原雷蔵'] = '08068286938'; localStorage.setItem('phoneMapping', JSON.stringify(phoneMapping)); }
    if (!masterNotes['前原雷蔵']) { masterNotes['前原雷蔵'] = '管理者'; localStorage.setItem('masterNotes', JSON.stringify(masterNotes)); }

    function getLineQrUrl(basicId) {
      // LINE official account QR code URL pattern
      const id = basicId.replace(/^@/, '').trim();
      if (!id) return '';
      if (id.startsWith('L')) return `https://qr-official.line.me/sid/L/${id}.png`;
      return `https://qr-official.line.me/sid/${id}.png`;
    }

    function openLineAddFriend(name) {
      const basicId = (lineSettings.lineBotId || '').trim();
      if (!basicId) {
        alert('LINE公式アカウントIDが設定されていません。設定画面から @ で始まるIDを入力してください。');
        return;
      }
      const url = basicId.startsWith('@') ? `https://line.me/R/ti/p/${encodeURIComponent(basicId)}` : `https://line.me/R/ti/p/${encodeURIComponent('@' + basicId)}`;
      window.open(url, '_blank');
    }

    function renderMasterTable() {
      const tbody = document.getElementById('master-table-body');
      const searchVal = (document.getElementById('master-search')?.value || '').toLowerCase();

      // Merge all known drivers from driverDB, lineMapping, phoneMapping, AND assignmentData
      const allDrivers = new Set([
        ...Object.keys(driverDB),
        ...Object.keys(lineMapping),
        ...Object.keys(phoneMapping),
        ...assignmentData.map(r => r.driverName).filter(Boolean)
      ]);
      let drivers = [...allDrivers].sort((a, b) => a.localeCompare(b, 'ja'));

      if (searchVal) {
        drivers = drivers.filter(name => name.toLowerCase().includes(searchVal));
      }

      let linked = 0, unlinked = 0;
      [...allDrivers].forEach(name => {
        if (lineMapping[name] || phoneMapping[name]) linked++; else unlinked++;
      });

      document.getElementById('master-total').textContent = `合計: ${allDrivers.size}名`;
      document.getElementById('master-linked').textContent = `紐付け済み: ${linked}名`;
      document.getElementById('master-unlinked').textContent = `未紐付け: ${unlinked}名`;

      if (drivers.length === 0) {
        tbody.innerHTML = `<tr><td colspan="11" class="px-4 py-12 text-center text-sm text-ink-lighter">
          ドライバーが登録されていません<br>
          <span class="text-xs">アサインデータのアップロードまたは手動追加で登録できます</span>
        </td></tr>`;
        return;
      }

      tbody.innerHTML = drivers.map(name => {
        const db = driverDB[name] || {};
        const lineId = lineMapping[name] || '';
        const phone = phoneMapping[name] || '';
        const hasLink = !!(lineId || phone);
        const note = masterNotes[name] || '';
        const statusLabel = lineId ? 'LINE連携済' : phone ? '電話番号のみ' : '未連携';
        const statusClass = lineId ? 'bg-emerald-50 text-emerald-700' : phone ? 'bg-blue-50 text-blue-700' : 'bg-gray-100 text-gray-500';
        const dotClass = lineId ? 'text-emerald-500' : phone ? 'text-blue-400' : 'text-gray-300';

        const basicId = (lineSettings.lineBotId || '').trim();
        const botLogoUrl = (lineSettings.lineBotLogoUrl || '').trim();
        const showAddBtn = !lineId && basicId;
        const addBtn = showAddBtn
          ? `<button onclick="openLineAddFriend('${name.replace(/'/g, "\\'")}')" title="友だち追加 / LINE待ち受け" class="ml-2 inline-flex items-center justify-center w-7 h-7 rounded-full overflow-hidden border border-border hover:opacity-80 transition-opacity">
              ${botLogoUrl ? `<img src="${botLogoUrl}" class="w-full h-full object-cover" alt="LINE友だち追加" onerror="this.style.display='none'">` : ''}
              <svg class="${botLogoUrl ? 'hidden' : 'w-4 h-4'} text-[#06C755]" viewBox="0 0 24 24" fill="currentColor"><path d="M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.627-.63h2.386c.349 0 .63.285.63.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.104.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.627-.63.349 0 .631.285.631.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.281.629-.629.629M12 1C5.373 1 0 5.373 0 12s5.373 11 12 11 12-4.373 12-11S18.627 1 12 1"/></svg>
             </button>`
          : '';

        const dept = driverDepartments[name] || '';
        const optionsHtml = DEPARTMENTS.map(function(d) {
          return '<option value="' + d.replace(/"/g, '&quot;') + '" ' + (dept === d ? 'selected' : '') + '>' + d + '</option>';
        }).join('');

        const jname = driverJapaneseNames[name] || '';
        // 既存の lineId を使用（再宣言しない）
        const profile = lineId && lineId.indexOf('U') === 0 ? lineProfileCache[lineId] : null;
        const pictureUrl = profile ? profile.pictureUrl : '';
        const displayName = profile ? profile.displayName : '';
        const fallbackIcon = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iI2NjYyI+PHBhdGggZD0iTTEyIDEyYzIuMjEgMCA0LTEuNzkgNC00cy0xLjc5LTQtNC00LTQgMS43OS00IDQgMS43OSA0IDQgNHptMCAyYy0yLjY3IDAtOCAxLjM0LTggNHYyaDE2di0yYzAtMi42Ni01LjMzLTQtOC00eiIvPjwvc3ZnPg==';
        const avatarHtml = '<img src="' + (pictureUrl || fallbackIcon).replace(/"/g, '&quot;') + '" class="w-8 h-8 rounded-full border border-border object-cover flex-shrink-0" alt="LINEアイコン">';

        return `<tr class="border-b border-border hover:bg-surface/50 transition-colors">
          <td class="px-4 py-2.5 text-center">
            <span class="${dotClass} text-lg" title="${statusLabel}">●</span>
          </td>
          <td class="px-4 py-2.5">
            <input type="text" value="${jname.replace(/"/g, '&quot;')}" placeholder="山田 太郎"
              class="border border-border rounded px-2 py-1 text-xs w-32 focus:outline-none focus:border-accent"
              onchange="updateJapaneseName('${name.replace(/'/g, "\\'")}', this.value)">
          </td>
          <td class="px-4 py-2.5 font-medium text-ink">
            <div class="flex items-center gap-2">
              ${avatarHtml}
              <div class="flex flex-col leading-tight">
                <span class="inline-flex items-center">${name}${addBtn}</span>
                ${displayName ? '<span class="text-xs text-ink-lighter font-normal">' + displayName.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span>' : ''}
              </div>
            </div>
          </td>
          <td class="px-4 py-2.5">
            <input type="text" value="${lineId}" placeholder="LINE User ID"
              class="border border-border rounded px-2 py-1 text-xs w-40 focus:outline-none focus:border-accent"
              onchange="updateLineId('${name.replace(/'/g, "\\'")}', this.value)">
          </td>
          <td class="px-4 py-2.5">
            <input type="text" value="${phone}" placeholder="090-xxxx-xxxx"
              class="border border-border rounded px-2 py-1 text-xs w-36 focus:outline-none focus:border-accent"
              onchange="updatePhone('${name.replace(/'/g, "\\'")}', this.value)">
          </td>
          <td class="px-4 py-2.5">
            <input type="text" value="${(transportIDs[name] || '').replace(/"/g, '&quot;')}" placeholder="Transport ID"
              class="border border-border rounded px-2 py-1 text-xs w-36 focus:outline-none focus:border-accent"
              onchange="updateLicenseNumber('${name.replace(/'/g, "\\'")}', this.value)">
          </td>
          <td class="px-4 py-2.5">
            <select class="border border-border rounded px-2 py-1 text-xs w-32 focus:outline-none focus:border-accent bg-white"
              onchange="updateDepartment('${name.replace(/'/g, "\\'")}', this.value)">
              <option value="">-- 所属 --</option>
              ${optionsHtml}
            </select>
          </td>
          <td class="px-4 py-2.5 text-center">
            <button onclick="showDriverQR('${name.replace(/'/g, "\\'")}')" class="px-2 py-1 rounded text-xs font-medium bg-blue-100 text-blue-700 hover:bg-blue-200 transition-colors">QR表示</button>
          </td>
          <td class="px-4 py-2.5">
            <span class="text-xs px-2 py-0.5 rounded ${statusClass} font-medium">${statusLabel}</span>
          </td>
          <td class="px-4 py-2.5">
            <input type="text" value="${note.replace(/"/g, '&quot;')}" placeholder="メモ"
              class="border border-border rounded px-2 py-1 text-xs w-32 focus:outline-none focus:border-accent"
              onchange="updateMasterNote('${name.replace(/'/g, "\\'")}', this.value)">
          </td>
          <td class="px-4 py-2.5">
            <button class="text-xs text-red-400 hover:text-red-600 transition-colors" onclick="deleteDriver('${name.replace(/'/g, "\\'")}')">削除</button>
          </td>
        </tr>`;
      }).join('');
    }

    function updateLineId(name, value) {
      value = value.trim();
      if (value) {
        lineMapping[name] = value;
      } else {
        delete lineMapping[name];
      }
      localStorage.setItem('lineMapping', JSON.stringify(lineMapping));

      // 新しいLINE IDが設定されたら即座にプロフィール取得（Uから始まる場合）
      if (value && value.indexOf('U') === 0) {
        refreshLineProfile(value);
      }

      renderMasterTable();
      renderLineMappings();
    }

    function updatePhone(name, value) {
      value = value.trim();
      if (value) {
        phoneMapping[name] = value;
      } else {
        delete phoneMapping[name];
      }
      localStorage.setItem('phoneMapping', JSON.stringify(phoneMapping));
      renderMasterTable();
    }

    function updateLicenseNumber(name, value) {
      value = value.trim();
      if (value) {
        transportIDs[name] = value;
      } else {
        delete transportIDs[name];
      }
      localStorage.setItem('transportIDs', JSON.stringify(transportIDs));
      renderMasterTable();
    }

    function updateDepartment(name, value) {
      value = value.trim();
      if (value) {
        driverDepartments[name] = value;
      } else {
        delete driverDepartments[name];
      }
      localStorage.setItem('driverDepartments', JSON.stringify(driverDepartments));
      renderMasterTable();
    }

    function updateJapaneseName(name, value) {
      value = value.trim();
      if (value) {
        driverJapaneseNames[name] = value;
      } else {
        delete driverJapaneseNames[name];
      }
      localStorage.setItem('driverJapaneseNames', JSON.stringify(driverJapaneseNames));
      renderMasterTable();
    }

    // ===== LINE Profile Cache =====
    function isProfileCacheExpired(profile) {
      if (!profile || !profile.fetchedAt) return true;
      return (Date.now() - profile.fetchedAt) > PROFILE_CACHE_TTL;
    }

    function saveProfileCache() {
      localStorage.setItem('lineProfileCache', JSON.stringify(lineProfileCache));
    }

    async function fetchLineProfile(userId) {
      var proxyUrl = (lineSettings.gasProxyUrl || '').trim();
      if (!proxyUrl) return null;
      if (userId.indexOf('U') !== 0) return null;

      var url = proxyUrl + (proxyUrl.indexOf('?') >= 0 ? '&' : '?') + 'action=getProfile&userId=' + encodeURIComponent(userId);

      try {
        var response = await fetch(url, { method: 'GET', mode: 'cors', credentials: 'omit' });
        var data = await response.json().catch(function() { return null; });
        if (!data || data.status === 'error' || !data.userId) return null;
        return {
          userId: data.userId,
          displayName: data.displayName || '',
          pictureUrl: data.pictureUrl || '',
          statusMessage: data.statusMessage || '',
          fetchedAt: Date.now()
        };
      } catch(e) {
        console.error('LINEプロフィール取得エラー:', e);
        return null;
      }
    }

    async function refreshLineProfile(userId) {
      if (!userId || userId.indexOf('U') !== 0) return;
      var cached = lineProfileCache[userId];
      if (cached && !isProfileCacheExpired(cached)) return;

      var profile = await fetchLineProfile(userId);
      if (profile) {
        lineProfileCache[userId] = profile;
        saveProfileCache();
        if (currentTab === 'master') renderMasterTable();
      }
    }

    function refreshAllLineProfiles() {
      var targets = [];
      for (var name in lineMapping) {
        var userId = lineMapping[name];
        if (userId && userId.indexOf('U') === 0) {
          targets.push(userId);
        }
      }
      if (targets.length === 0) return;

      // 重複排除
      var seen = {};
      targets = targets.filter(function(userId) {
        if (seen[userId]) return false;
        seen[userId] = true;
        return true;
      });

      // 順番に取得（同時実行しすぎないよう200ms間隔）
      var i = 0;
      function next() {
        if (i >= targets.length) return;
        var userId = targets[i++];
        refreshLineProfile(userId).then(function() {
          setTimeout(next, 200);
        });
      }
      next();
    }

    // ===== QR Code Generation (qrcodejs) =====
    function getQRData(name) {
      var tid = transportIDs[name];

      // Transport IDがあればIDのみ（日本語なし＝読み取り安定）
      if (typeof tid === "string") {
        tid = tid.trim();
        if (tid.length > 0 && tid.length <= 100) {
          return tid;
        }
      }

      // Transport ID未登録の場合はASCII形式のフォールバック
      // driverDB からインデックスを生成
      var keys = Object.keys(driverDB).sort();
      var idx = keys.indexOf(name);
      if (idx >= 0) {
        return "OFK3_D" + ("0000" + (idx + 1)).slice(-4);
      }

      // どこにもなければ名前ベース（最終手段）
      return "OFK3_DRIVER:" + name;
    }

    var currentQRInstance = null;

    function showDriverQR(name) {
      var qrData = getQRData(name);
      var modal = document.getElementById('qr-modal');
      var tid = transportIDs[name];

      console.log("名前:", name);
      console.log("TransportID:", tid);
      console.log("型:", typeof tid);
      console.log("QRデータ:", qrData);
      console.log("QR文字数:", qrData.length);
      // Transport IDが長すぎる場合はクリーンアップ
      if (tid && String(tid).length > 50) {
        console.warn('Transport ID too long for ' + name + ': ' + String(tid).length + ' chars');
        delete transportIDs[name];
        localStorage.setItem('transportIDs', JSON.stringify(transportIDs));
        qrData = 'OFK3_DRIVER:' + name;
        tid = null;
        alert(name + ' のTransport IDが異常データでした。リセットしました。再度設定してください。');
      }
      document.getElementById('qr-modal-name').textContent = name;
      document.getElementById('qr-modal-data').textContent = tid ? 'Transport ID: ' + tid : 'ドライバー名で生成';
      modal.classList.remove('hidden');

      var container = document.getElementById('qr-modal-render');
      container.innerHTML = '';
      try {
        var canvas = document.createElement('canvas');
        canvas.style.cssText = 'padding:20px;background:#fff';
        container.appendChild(canvas);
        currentQRInstance = new QRious({
          element: canvas,
          value: qrData,
          size: 400,
          foreground: '#000000',
          background: '#ffffff',
          level: 'H',
          padding: 30
        });
      } catch(e) {
        container.innerHTML = '<p class="text-red-500 text-sm">QR生成エラー: データが長すぎます</p>';
        console.error('QR error for ' + name + ':', e);
      }
    }

    function closeQrModal() {
      document.getElementById('qr-modal').classList.add('hidden');
    }

    function getQRImageSrc() {
      var container = document.getElementById('qr-modal-render');
      var img = container.querySelector('img');
      if (img) return img.src;
      var canvas = container.querySelector('canvas');
      if (canvas) return canvas.toDataURL('image/png');
      return '';
    }

    function downloadQR(name) {
      var src = getQRImageSrc();
      if (!src) { alert('QRコードが生成されていません'); return; }
      var a = document.createElement('a');
      a.href = src;
      a.download = 'QR_' + name + '.png';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }

    function printQR(name) {
      var imgData = getQRImageSrc();
      if (!imgData) { alert('QRコードが生成されていません'); return; }
      var win = window.open('', '_blank', 'width=400,height=500');
      win.document.write(
        '<!DOCTYPE html><html><head><title>QR - ' + name + '</title>' +
        '<style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;margin:0}' +
        'img{width:250px;height:250px}h2{margin:20px 0 5px;font-size:18px}p{color:#666;font-size:12px}</style></head>' +
        '<body><h2>' + name + '</h2><p>OFK3 点呼認証用QRコード</p><img src="' + imgData + '"><script>window.onload=function(){window.print()}<\/script></body></html>'
      );
      win.document.close();
    }

    function printAllQR() {
      var drivers = [...new Set([
        ...Object.keys(driverDB),
        ...Object.keys(lineMapping),
        ...Object.keys(phoneMapping),
        ...Object.keys(transportIDs)
      ])].sort((a, b) => a.localeCompare(b, 'ja'));
      if (drivers.length === 0) { alert('ドライバーが登録されていません'); return; }

      // 一時的にQRを生成して画像を収集
      var tempDiv = document.createElement('div');
      tempDiv.style.cssText = 'position:absolute;left:-9999px;top:-9999px';
      document.body.appendChild(tempDiv);

      var cards = [];
      var done = 0;
      drivers.forEach(function(name) {
        var tid = transportIDs[name];
        // 異常データをスキップ
        if (tid && String(tid).length > 50) {
          done++;
          if (done === drivers.length) { finishPrintQR(cards, tempDiv); }
          return;
        }
        var qrData = tid ? tid : 'OFK3_DRIVER:' + name;
        var qrDiv = document.createElement('div');
        tempDiv.appendChild(qrDiv);
        try {
          var qrCanvas = document.createElement('canvas');
          qrDiv.appendChild(qrCanvas);
          new QRious({ element: qrCanvas, value: qrData, size: 250, foreground: '#000000', background: '#ffffff', level: 'H', padding: 20 });
        } catch(e) {
          console.error('QR error for ' + name, e);
          done++;
          if (done === drivers.length) { finishPrintQR(cards, tempDiv); }
          return;
        }

        // QRiousはcanvasに即座に描画するので短い待機でOK
        setTimeout(function() {
          var c = qrDiv.querySelector('canvas');
          var imgSrc = c ? c.toDataURL('image/png') : '';
          cards.push({ name: name, imgData: imgSrc, tid: tid || 'OFK3' });
          done++;
          if (done === drivers.length) {
            finishPrintQR(cards, tempDiv);
          }
        }, 500);
      });
    }

    function finishPrintQR(cards, tempDiv) {
      document.body.removeChild(tempDiv);
      var win = window.open('', '_blank', 'width=800,height=600');
      var html = cards.map(function(r) {
        return '<div style="border:1px solid #ccc;border-radius:8px;padding:16px;text-align:center;break-inside:avoid;background:#fff">' +
          '<div style="padding:16px;background:#fff;display:inline-block"><img src="' + r.imgData + '" style="width:150px;height:150px"></div>' +
          '<div style="font-weight:bold;margin-top:8px;font-size:14px">' + r.name + '</div>' +
          '<div style="color:#666;font-size:10px">' + r.tid + '</div></div>';
      }).join('');
      win.document.write(
        '<!DOCTYPE html><html><head><title>QR一覧 - OFK3</title>' +
        '<style>body{font-family:sans-serif;padding:20px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}' +
        'h1{font-size:18px;margin-bottom:16px}@media print{.no-print{display:none}}</style></head>' +
        '<body><h1>OFK3 点呼認証QRコード一覧</h1>' +
        '<button class="no-print" onclick="window.print()" style="margin-bottom:16px;padding:8px 16px;background:#3b82f6;color:white;border:none;border-radius:6px;cursor:pointer">印刷</button>' +
        '<div class="grid">' + html + '</div></body></html>'
      );
      win.document.close();
    }

    function updateMasterNote(name, value) {
      if (value.trim()) {
        masterNotes[name] = value.trim();
      } else {
        delete masterNotes[name];
      }
      localStorage.setItem('masterNotes', JSON.stringify(masterNotes));
    }

    function addNewDriver() {
      const name = prompt('ドライバー名を入力してください:');
      if (!name || !name.trim()) return;
      const trimmed = name.trim();
      if (driverDB[trimmed] || lineMapping[trimmed]) {
        alert('このドライバーは既に登録されています');
        return;
      }
      driverDB[trimmed] = {
        packagesPerHour: null,
        deliveryRate: null,
        workDays: 0,
        totalPackages: 0,
        incidents: 0,
        lastUpdated: new Date().toISOString().split('T')[0],
        history: []
      };
      localStorage.setItem('driverDB', JSON.stringify(driverDB));
      renderMasterTable();
    }

    function deleteDriver(name) {
      if (!confirm(`「${name}」を削除しますか？\nドライバーDB・LINE紐付け・電話番号・所属・メモすべて削除されます。`)) return;
      delete driverDB[name];
      delete lineMapping[name];
      delete phoneMapping[name];
      delete transportIDs[name];
      delete driverDepartments[name];
      delete driverJapaneseNames[name];
      delete masterNotes[name];
      localStorage.setItem('driverDB', JSON.stringify(driverDB));
      localStorage.setItem('lineMapping', JSON.stringify(lineMapping));
      localStorage.setItem('phoneMapping', JSON.stringify(phoneMapping));
      localStorage.setItem('transportIDs', JSON.stringify(transportIDs));
      localStorage.setItem('driverDepartments', JSON.stringify(driverDepartments));
      localStorage.setItem('driverJapaneseNames', JSON.stringify(driverJapaneseNames));
      localStorage.setItem('masterNotes', JSON.stringify(masterNotes));
      renderMasterTable();
    }

    function exportMasterData() {
      const allDrivers = new Set([
        ...Object.keys(driverDB),
        ...Object.keys(lineMapping),
        ...Object.keys(phoneMapping),
        ...assignmentData.map(r => r.driverName).filter(Boolean)
      ]);
      const rows = [['ドライバー名', '名前（日本語）', '所属', 'LINE User ID', '電話番号', '能力(個/h)', '配管率(%)', '稼働日数', '総配送数', 'メモ', '連携状態']];

      [...allDrivers].sort((a, b) => a.localeCompare(b, 'ja')).forEach(name => {
        const db = driverDB[name] || {};
        rows.push([
          name,
          driverJapaneseNames[name] || '',
          driverDepartments[name] || '',
          lineMapping[name] || '',
          phoneMapping[name] || '',
          db.packagesPerHour || '',
          db.deliveryRate || '',
          db.workDays || '',
          db.totalPackages || '',
          masterNotes[name] || '',
          lineMapping[name] ? 'LINE連携済' : phoneMapping[name] ? '電話番号のみ' : '未連携'
        ]);
      });

      const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
      const bom = '\uFEFF';
      const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `マスタデータ_${new Date().toISOString().split('T')[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    }

    // ===== LINE Integration =====
    let lineSettings = JSON.parse(localStorage.getItem('lineSettings') || '{}');
    if (!lineSettings.adminLineId) { lineSettings.adminLineId = 'raizo0428gion'; }
    if (!lineSettings.lineBotId) { lineSettings.lineBotId = '@046vllck'; }
    if (!lineSettings.gasProxyUrl) { lineSettings.gasProxyUrl = 'https://ofk3-line-proxy-1.onrender.com/proxy'; }
    localStorage.setItem('lineSettings', JSON.stringify(lineSettings));
    let notifyMode = 'notify';

    // Load saved settings on init
    function initLineSettings() {
      if (lineSettings.notifyToken) {
        document.getElementById('line-notify-token').value = lineSettings.notifyToken;
        document.getElementById('notify-status').textContent = '設定済み';
        document.getElementById('notify-status').className = 'text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-medium';
      }
      if (lineSettings.channelToken) {
        document.getElementById('line-channel-token').value = lineSettings.channelToken;
      }
      if (lineSettings.channelSecret) {
        document.getElementById('line-channel-secret').value = lineSettings.channelSecret;
      }
      if (lineSettings.channelToken && lineSettings.channelSecret) {
        document.getElementById('messaging-status').textContent = '設定済み';
        document.getElementById('messaging-status').className = 'text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-medium';
      }
      if (lineSettings.messageTemplate) {
        document.getElementById('line-message-template').value = lineSettings.messageTemplate;
      }
      if (lineSettings.adminLineId) {
        document.getElementById('line-admin-id').value = lineSettings.adminLineId;
      }
      if (lineSettings.lineBotId) {
        document.getElementById('line-bot-id').value = lineSettings.lineBotId;
      }
      if (lineSettings.lineBotLogoUrl) {
        document.getElementById('line-bot-logo-url').value = lineSettings.lineBotLogoUrl;
      }
      if (lineSettings.gasProxyUrl) {
        document.getElementById('gas-proxy-url').value = lineSettings.gasProxyUrl;
      }
      renderLineMappings();
    }

    function saveLineSettings() {
      lineSettings = {
        notifyToken: document.getElementById('line-notify-token')?.value || '',
        channelToken: document.getElementById('line-channel-token')?.value || '',
        channelSecret: document.getElementById('line-channel-secret')?.value || '',
        messageTemplate: document.getElementById('line-message-template')?.value || '',
        adminLineId: document.getElementById('line-admin-id')?.value || '',
        lineBotId: document.getElementById('line-bot-id')?.value || '',
        lineBotLogoUrl: document.getElementById('line-bot-logo-url')?.value || '',
        gasProxyUrl: document.getElementById('gas-proxy-url')?.value || ''
      };
      localStorage.setItem('lineSettings', JSON.stringify(lineSettings));

      // Update status badges
      const notifyStatus = document.getElementById('notify-status');
      if (lineSettings.notifyToken) {
        notifyStatus.textContent = '設定済み';
        notifyStatus.className = 'text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-medium';
      } else {
        notifyStatus.textContent = '未設定';
        notifyStatus.className = 'text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-700';
      }
      const msgStatus = document.getElementById('messaging-status');
      if (lineSettings.channelToken && lineSettings.channelSecret) {
        msgStatus.textContent = '設定済み';
        msgStatus.className = 'text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-medium';
      } else {
        msgStatus.textContent = '未設定';
        msgStatus.className = 'text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-700';
      }
    }

    function addDriverLineMapping() {
      const driverNames = Object.keys(driverDB);
      if (driverNames.length === 0) {
        alert('先にドライバーデータをアップロードしてください');
        return;
      }

      const name = prompt('ドライバー名を入力してください\n\n登録済み:\n' + driverNames.slice(0, 10).join('\n') + (driverNames.length > 10 ? '\n...' : ''));
      if (!name) return;

      const lineId = prompt(`${name} さんの LINE User ID を入力してください\n（U から始まる33文字の文字列）`);
      if (!lineId) return;

      lineMapping[name] = lineId;
      localStorage.setItem('lineMapping', JSON.stringify(lineMapping));
      if (lineId.indexOf('U') === 0) {
        refreshLineProfile(lineId);
      }
      renderLineMappings();
    }

    function removeLineMapping(name) {
      delete lineMapping[name];
      localStorage.setItem('lineMapping', JSON.stringify(lineMapping));
      renderLineMappings();
    }

    function renderLineMappings() {
      const container = document.getElementById('line-mapping-list');
      if (!container) return;
      const entries = Object.entries(lineMapping);

      if (entries.length === 0) {
        container.innerHTML = '<p class="text-xs text-ink-lighter py-2">紐付けなし — 「+ 追加」から登録してください</p>';
        return;
      }

      container.innerHTML = entries.map(([name, id]) => `
        <div class="flex items-center justify-between bg-surface rounded px-2 py-1.5">
          <div class="flex items-center gap-2">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="#06C755"><path d="M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.627-.63h2.386c.349 0 .63.285.63.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.104.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.627-.63.349 0 .631.285.631.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.281.629-.629.629M12 1C5.373 1 0 5.373 0 12s5.373 11 12 11 12-4.373 12-11S18.627 1 12 1"/></svg>
            <span class="text-xs font-medium">${name}</span>
            <span class="text-xs text-ink-lighter font-mono">${id.substring(0, 8)}...</span>
          </div>
          <button class="text-xs text-accent hover:underline" onclick="removeLineMapping('${name}')">削除</button>
        </div>
      `).join('');
    }

    function setNotifyMode(mode) {
      notifyMode = mode;
      const btnNotify = document.getElementById('mode-notify');
      const btnMessaging = document.getElementById('mode-messaging');

      if (mode === 'notify') {
        btnNotify.className = 'text-xs px-3 py-1.5 rounded border border-accent bg-accent-light text-accent font-medium';
        btnMessaging.className = 'text-xs px-3 py-1.5 rounded border border-border text-ink-light';
        updateNotificationPreview('notify');
      } else {
        btnMessaging.className = 'text-xs px-3 py-1.5 rounded border border-accent bg-accent-light text-accent font-medium';
        btnNotify.className = 'text-xs px-3 py-1.5 rounded border border-border text-ink-light';
        updateNotificationPreview('messaging');
      }

      // Update button state
      const isConfigured = mode === 'notify' ? !!lineSettings.notifyToken : !!(lineSettings.channelToken && lineSettings.channelSecret);
      document.getElementById('line-not-configured').classList.toggle('hidden', isConfigured);
      document.getElementById('line-ready').classList.toggle('hidden', !isConfigured);
      const sendBtn = document.getElementById('send-line-btn');
      sendBtn.disabled = !isConfigured;
      sendBtn.className = isConfigured
        ? 'btn-primary text-sm px-4 py-2 rounded'
        : 'btn-primary text-sm px-4 py-2 rounded opacity-50 cursor-not-allowed';
    }

    function updateNotificationPreview(mode) {
      const preview = document.getElementById('notification-preview');
      if (mode === 'notify') {
        // Group notification preview
        const today = new Date().toLocaleDateString('ja-JP');
        const lines = [`【本日の配送予測】${today}`, '━━━━━━━━━━━━━'];
        assignmentData.filter(r => r.driverName).forEach(r => {
          lines.push(`${r.driverName} → ${r.routeCode} / ${r.totalDeliveries}個 / 終了 ${r.predictedEnd}`);
        });
        lines.push('━━━━━━━━━━━━━');
        preview.textContent = lines.join('\n');
      } else {
        // Individual notification preview
        const template = lineSettings.messageTemplate || document.getElementById('line-message-template')?.value || '';
        const sample = assignmentData.find(r => r.driverName) || {};
        const filled = template
          .replace('{driver}', sample.driverName || 'ドライバー名')
          .replace('{route}', sample.routeCode || 'DCX00')
          .replace('{area}', sample.area || '下山門～姪浜')
          .replace('{packages}', sample.totalDeliveries || '0')
          .replace('{destinations}', sample.allDestinations || '0')
          .replace('{departure}', sample.departure || '09:00')
          .replace('{predicted_end}', sample.predictedEnd || '17:00');

        const mappedCount = Object.keys(lineMapping).length;
        const totalDrivers = assignmentData.filter(r=>r.driverName).length;
        const adminId = lineSettings.adminLineId;

        let previewText = `【ドライバーへの個別通知（各自のコースのみ）】\n\n${filled}\n\n`;
        previewText += `━━━━━━━━━━━━━\n`;
        previewText += `【管理者への通知（全体一覧）】\n\n`;

        const today = new Date().toLocaleDateString('ja-JP');
        previewText += `配送予測一覧 ${today}\n`;
        assignmentData.filter(r => r.driverName).slice(0, 4).forEach(r => {
          previewText += `  ${r.routeCode} ${r.driverName} → ${r.totalDeliveries}個 / 終了 ${r.predictedEnd}\n`;
        });
        if (assignmentData.length > 4) previewText += `  ...他${assignmentData.length - 4}件\n`;

        previewText += `\n━━━━━━━━━━━━━\n`;
        previewText += `送信対象: ドライバー ${mappedCount}/${totalDrivers}名（ID紐付け済み）\n`;
        previewText += `管理者: ${adminId ? '設定済み' : '未設定（設定画面から登録）'}`;

        preview.textContent = previewText;
      }
    }

    function openLineSendModal() {
      if (!assignmentData.length) {
        alert('先にアサインデータをアップロードしてください');
        return;
      }

      // Set default mode and preview
      setNotifyMode('notify');

      document.getElementById('line-modal').classList.remove('hidden');
    }

    async function sendLineNotification() {
      if (notifyMode === 'notify') {
        await sendViaNotify();
      } else {
        await sendViaMessagingAPI();
      }
    }

    async function sendViaNotify() {
      const token = lineSettings.notifyToken;
      if (!token) { alert('LINE Notifyトークンが設定されていません'); return; }

      const today = new Date().toLocaleDateString('ja-JP');
      let message = `\n【本日の配送予測】${today}\n━━━━━━━━━━━━━\n`;
      assignmentData.filter(r => r.driverName).forEach(r => {
        message += `${r.driverName} → ${r.routeCode} / ${r.totalDeliveries}個 / 終了 ${r.predictedEnd}\n`;
      });
      message += '━━━━━━━━━━━━━';

      try {
        const response = await fetch('https://notify-api.line.me/api/notify', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: `message=${encodeURIComponent(message)}`
        });

        if (response.ok) {
          alert('LINE Notifyで通知を送信しました！');
          closeModal();
        } else {
          const data = await response.json().catch(() => ({}));
          alert(`送信エラー: ${data.message || response.statusText}\n\nCORSエラーの場合は、プロキシサーバーの設定が必要です。`);
        }
      } catch (e) {
        // CORS error expected from browser - show helpful message
        alert(`ブラウザからの直接送信はCORSにより制限されています。\n\n以下の方法で解決できます：\n1. Google Apps Script をプロキシとして使用\n2. Cloudflare Workers を使用\n3. 簡易Node.jsサーバーを立てる\n\n設定方法は別途ご案内します。`);
      }
    }

    async function sendViaMessagingAPI() {
      const token = lineSettings.channelToken;
      if (!token) { alert('チャネルアクセストークンが設定されていません'); return; }
      const proxyUrl = lineSettings.gasProxyUrl?.trim();
      if (!proxyUrl) { alert('GASプロキシURLが設定されていません'); return; }

      const template = lineSettings.messageTemplate || document.getElementById('line-message-template')?.value || '';
      let sent = 0;
      let failed = 0;
      let skipped = 0;

      // Helper to push via GAS proxy
      async function pushViaProxy(to, messages) {
        try {
          const response = await fetch(proxyUrl, {
            method: 'POST',
            mode: 'cors',
            redirect: 'follow',
            credentials: 'omit',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to, messages })
          });
          const data = await response.json().catch(() => ({}));
          if (response.ok) {
            return { ok: true, status: response.status, data };
          } else {
            return { ok: false, status: response.status, data };
          }
        } catch (e) {
          return { ok: false, status: 0, data: { message: e.message || String(e) } };
        }
      }

      // 1. ドライバーに個別送信（自分のコースと物量のみ）
      for (const route of assignmentData) {
        if (!route.driverName) continue;
        const userId = lineMapping[route.driverName];
        if (!userId) { skipped++; continue; }

        const message = template
          .replace('{driver}', route.driverName)
          .replace('{route}', route.routeCode)
          .replace('{area}', route.area || '未設定')
          .replace('{packages}', route.totalDeliveries)
          .replace('{destinations}', route.allDestinations)
          .replace('{departure}', route.departure)
          .replace('{predicted_end}', route.predictedEnd);

        try {
          const { ok, status, data } = await pushViaProxy(userId, [{ type: 'text', text: message }]);
          if (ok) { sent++; } else { failed++; console.error('Driver push failed:', status, data); }
        } catch (e) {
          failed++;
          console.error('Driver push error:', e);
        }
      }

      // 2. 管理者に全体一覧を送信（テキスト形式 — サイズ制限回避）
      const adminIdRaw = lineSettings.adminLineId || '';
      const adminIds = adminIdRaw.split(',').map(s => s.trim()).filter(Boolean);
      let adminSent = 0;
      let adminFailed = 0;
      if (adminIds.length > 0) {
        const today = new Date().toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
        const totalPkg = assignmentData.reduce((s,r)=>s+r.totalDeliveries, 0);
        const totalDest = assignmentData.reduce((s,r)=>s+r.allDestinations, 0);
        const lastEnd = assignmentData.reduce((l,r) => r.predictedEnd > l ? r.predictedEnd : l, '00:00');

        // テキストメッセージで全体一覧を生成（5000文字制限のため分割送信）
        const header = `📦 配送予測一覧\n${today} | OFK3\n${assignmentData.length}ルート | ${totalPkg}個 | ${totalDest}件\n最終完了予測: ${lastEnd}\n${'─'.repeat(20)}`;
        const rows = assignmentData.filter(r => r.driverName).map(r =>
          `${r.routeCode} ${r.driverName}\n  ${(r.area||'-').split('・').slice(0,2).join('・')} | ${r.totalDeliveries}個 ${r.allDestinations}件 | 終了${r.predictedEnd}${r.status==='risk'?' ⚠️':''}`
        );

        // 5000文字以内に収まるようメッセージを分割
        const messages = [];
        let current = header;
        for (const row of rows) {
          if ((current + '\n' + row).length > 4500) {
            messages.push(current);
            current = `📦 配送予測一覧（続き）\n${'─'.repeat(20)}`;
          }
          current += '\n' + row;
        }
        current += `\n${'─'.repeat(20)}\n合計: ${totalPkg}個 / ${totalDest}件 | 最終完了: ${lastEnd}`;
        messages.push(current);

        for (const adminId of adminIds) {
          try {
            // LINEは1回のpushで最大5メッセージまで
            for (let i = 0; i < messages.length; i += 5) {
              const chunk = messages.slice(i, i + 5).map(t => ({ type: 'text', text: t }));
              const { ok, status, data } = await pushViaProxy(adminId, chunk);
              if (!ok) { adminFailed++; console.error('Admin push failed:', adminId, status, JSON.stringify(data)); break; }
            }
            if (adminFailed === 0) adminSent++;
          } catch (e) {
            adminFailed++;
            console.error('Admin push error:', adminId, e.message || e);
          }
        }
      }

      // 結果表示
      let result = `【送信結果】\n`;
      result += `ドライバー個別送信: ${sent}件 成功`;
      if (skipped > 0) result += ` / ${skipped}件 ID未登録でスキップ`;
      if (failed > 0) result += ` / ${failed}件 失敗`;
      result += `\n管理者通知: ${adminIds.length > 0 ? adminSent + '/' + adminIds.length + '件 成功' : 'ID未設定'}`;
      if (adminFailed > 0) result += `（${adminFailed}件 失敗）`;
      if (adminIds.length === 0) result += '\n\n※ 設定画面で管理者LINE IDを登録すると全体一覧が届きます';
      result += '\n\nGASプロキシURL:\n' + (lineSettings.gasProxyUrl || '未設定');

      alert(result);
      closeModal();
    }

    async function testLineNotify() {
      const token = document.getElementById('line-notify-token').value;
      if (!token) { alert('トークンを入力してください'); return; }

      try {
        const response = await fetch('https://notify-api.line.me/api/notify', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: 'message=' + encodeURIComponent('\n【テスト送信】配送管理アプリからの通知テストです。')
        });

        if (response.ok) {
          alert('テスト送信成功！LINEグループを確認してください。');
        } else {
          alert('送信に失敗しました。トークンを確認してください。');
        }
      } catch (e) {
        alert(`CORSエラー: ブラウザからの直接呼び出しは制限されています。\nトークン自体は保存されました。プロキシ経由で動作します。`);
      }
    }

    // ===== Print / Export =====
    function openPrintPreview() {
      if (!assignmentData.length) {
        alert('先にアサインデータをアップロードしてください');
        return;
      }

      const today = new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
      const totalPackages = assignmentData.reduce((sum, r) => sum + r.totalDeliveries, 0);
      const totalRoutes = assignmentData.length;

      // Sort by departure time
      const sorted = [...assignmentData].sort((a, b) => a.departure.localeCompare(b.departure));

      const html = `
        <div style="font-family: 'Noto Sans JP', sans-serif; padding: 8px;">
          <!-- Header -->
          <div style="text-align: center; margin-bottom: 16px; border-bottom: 2px solid #2D2D2D; padding-bottom: 12px;">
            <h1 style="font-size: 20px; font-weight: 700; margin: 0 0 4px 0;">本日の配送予測表</h1>
            <p style="font-size: 13px; color: #6B6B6B; margin: 0;">${today}　｜　OFK3　｜　${totalRoutes}ルート　｜　合計 ${totalPackages.toLocaleString()} 個</p>
          </div>

          <!-- Table -->
          <table class="print-preview-table">
            <thead>
              <tr>
                <th style="width: 70px;">ルート</th>
                <th>ドライバー</th>
                <th style="width: 80px;">種別</th>
                <th style="width: 60px; text-align: right;">配達数</th>
                <th style="width: 60px; text-align: right;">目的地</th>
                <th style="width: 60px; text-align: center;">出発</th>
                <th style="width: 70px; text-align: center; font-weight: 700;">終了予測</th>
                <th style="width: 60px; text-align: center;">備考</th>
              </tr>
            </thead>
            <tbody>
              ${sorted.map(route => {
                const note = route.status === 'risk' ? '<span style="color:#D94032;font-weight:600;">遅延注意</span>' :
                             route.status === 'warning' ? '<span style="color:#B45309;">要確認</span>' : '';
                return `<tr>
                  <td style="font-family: monospace; font-weight: 500;">${route.routeCode}</td>
                  <td>${route.driverName || '-'}</td>
                  <td style="font-size: 11px; color: #6B6B6B;">${shortenService(route.serviceType)}</td>
                  <td style="text-align: right; font-family: monospace; font-weight: 500;">${route.totalDeliveries}</td>
                  <td style="text-align: right; font-family: monospace;">${route.allDestinations}</td>
                  <td style="text-align: center; font-family: monospace;">${route.departure}</td>
                  <td style="text-align: center; font-family: monospace; font-weight: 700; font-size: 13px;">${route.predictedEnd}</td>
                  <td style="text-align: center; font-size: 11px;">${note}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>

          <!-- Footer -->
          <div style="margin-top: 12px; padding-top: 8px; border-top: 1px solid #DDD; display: flex; justify-content: space-between; font-size: 10px; color: #9A9A9A;">
            <span>※ 終了予測はドライバー能力値に基づく推定値です</span>
            <span>出力: ${new Date().toLocaleTimeString('ja-JP', {hour:'2-digit', minute:'2-digit'})}</span>
          </div>
        </div>
      `;

      document.getElementById('print-content').innerHTML = html;
      document.getElementById('print-modal').classList.remove('hidden');
    }

    function closePrintPreview() {
      document.getElementById('print-modal').classList.add('hidden');
    }

    function printTable() {
      const content = document.getElementById('print-content').innerHTML;
      const printWindow = window.open('', '_blank', 'width=800,height=600');
      printWindow.document.write(`
        <!DOCTYPE html>
        <html lang="ja">
        <head>
          <meta charset="UTF-8">
          <title>配送予測表 - 点呼場掲示用</title>
          <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&display=swap" rel="stylesheet">
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { font-family: 'Noto Sans JP', sans-serif; padding: 20px; }
            table { width: 100%; border-collapse: collapse; font-size: 12px; }
            th { background: #F5F5F5; border: 1px solid #DDD; padding: 6px 10px; font-weight: 600; text-align: left; }
            td { border: 1px solid #DDD; padding: 5px 10px; }
            tr:nth-child(even) { background: #FAFAFA; }
            @media print {
              body { padding: 10px; }
              @page { size: A4 landscape; margin: 10mm; }
            }
          </style>
        </head>
        <body>
          ${content}
          <script>window.onload = function() { window.print(); }<\/script>
        </body>
        </html>
      `);
      printWindow.document.close();
    }

    // ===== 点呼LINE自動通知 =====
    var NOTIFY_SLOTS = [
      { time: '09:00', minutes: 540 },
      { time: '11:00', minutes: 660 },
      { time: '14:40', minutes: 880 }
    ];

    var tenkoNotifySent = {};
    var tenkoNotifyDisabled = JSON.parse(localStorage.getItem('tenkoNotifyDisabled') || '{}');
    var tenkoNotifyLogs = JSON.parse(localStorage.getItem('tenkoNotifyLogs') || '[]');

    function renderNotifySlots() {
      var container = document.getElementById('line-notify-slots');
      if (!container) return;

      var now = new Date();
      var currentMinutes = now.getHours() * 60 + now.getMinutes();

      container.innerHTML = NOTIFY_SLOTS.map(function(slot) {
        var disabled = tenkoNotifyDisabled[slot.time];
        var sent = tenkoNotifySent['admin_' + slot.time];
        var isPast = currentMinutes >= slot.minutes;

        var statusText, statusClass;
        if (disabled) {
          statusText = '解除済み';
          statusClass = 'bg-gray-100 text-gray-500';
        } else if (sent) {
          statusText = '送信済み ✅';
          statusClass = 'bg-green-100 text-green-700';
        } else if (isPast) {
          statusText = '対象者なし';
          statusClass = 'bg-gray-100 text-gray-500';
        } else {
          statusText = '待機中';
          statusClass = 'bg-yellow-100 text-yellow-700';
        }

        var driversAtSlot = tenkoSchedule.filter(function(d) { return d.arrivalTime === slot.time; });
        var incomplete = driversAtSlot.filter(function(d) { return !d.licenseAuth || !d.mentorAuth; });

        var btnHtml;
        if (disabled) {
          btnHtml = '<button onclick="enableNotifySlot(\'' + slot.time + '\')" class="text-xs px-3 py-1 rounded bg-blue-100 text-blue-700 hover:bg-blue-200 cursor-pointer">有効化</button>';
        } else {
          btnHtml = '<button onclick="disableNotifySlot(\'' + slot.time + '\')" class="text-xs px-3 py-1 rounded bg-red-100 text-red-600 hover:bg-red-200 cursor-pointer">解除</button>';
        }

        return '<div class="flex items-center justify-between py-2 px-3 rounded ' + (disabled ? 'bg-gray-50 opacity-60' : 'bg-white border border-border') + '">' +
          '<div class="flex items-center gap-3">' +
            '<span class="font-mono font-bold text-sm">' + slot.time + '</span>' +
            '<span class="text-xs px-2 py-0.5 rounded-full ' + statusClass + '">' + statusText + '</span>' +
            '<span class="text-xs text-ink-lighter">' + driversAtSlot.length + '名' + (incomplete.length > 0 ? '（未完了' + incomplete.length + '名）' : '') + '</span>' +
          '</div>' +
          btnHtml +
        '</div>';
      }).join('');

      var logContainer = document.getElementById('line-notify-log');
      var logEntries = document.getElementById('line-notify-log-entries');
      if (logContainer && logEntries && tenkoNotifyLogs.length > 0) {
        logContainer.classList.remove('hidden');
        logEntries.innerHTML = tenkoNotifyLogs.slice(-20).reverse().map(function(log) {
          return '<div class="text-xs py-1 border-b border-gray-100 ' + (log.type === 'admin' ? 'text-red-600' : 'text-blue-600') + '">' +
            '<span class="text-ink-lighter">' + log.time + '</span> ' + log.icon + ' ' + log.message + '</div>';
        }).join('');
      }
    }

    function disableNotifySlot(time) {
      tenkoNotifyDisabled[time] = true;
      localStorage.setItem('tenkoNotifyDisabled', JSON.stringify(tenkoNotifyDisabled));
      addNotifyLog('system', '🚫', time + ' の自動通知を解除しました');
      renderNotifySlots();
    }

    function enableNotifySlot(time) {
      delete tenkoNotifyDisabled[time];
      localStorage.setItem('tenkoNotifyDisabled', JSON.stringify(tenkoNotifyDisabled));
      addNotifyLog('system', '✅', time + ' の自動通知を有効化しました');
      renderNotifySlots();
    }

    function addNotifyLog(type, icon, message) {
      var entry = {
        time: new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }),
        type: type,
        icon: icon,
        message: message
      };
      tenkoNotifyLogs.push(entry);
      if (tenkoNotifyLogs.length > 50) tenkoNotifyLogs = tenkoNotifyLogs.slice(-50);
      localStorage.setItem('tenkoNotifyLogs', JSON.stringify(tenkoNotifyLogs));

      var scanLog = document.getElementById('scan-log-entries');
      if (scanLog) {
        var el = document.createElement('div');
        el.className = 'text-xs py-1 border-b border-gray-100 ' + (type === 'admin' ? 'text-red-600' : 'text-blue-600');
        el.textContent = entry.time + ' ' + icon + ' ' + message;
        scanLog.insertBefore(el, scanLog.firstChild);
      }
    }

    function checkTenkoLineNotify() {
      if (tenkoSchedule.length === 0) return;
      var proxyUrl = (lineSettings.gasProxyUrl || '').trim();
      if (!proxyUrl) return;

      var now = new Date();
      var currentMinutes = now.getHours() * 60 + now.getMinutes();

      NOTIFY_SLOTS.forEach(function(slot) {
        if (tenkoNotifyDisabled[slot.time]) return;

        var driversAtSlot = tenkoSchedule.filter(function(d) { return d.arrivalTime === slot.time; });
        var incomplete = driversAtSlot.filter(function(d) { return !d.licenseAuth || !d.mentorAuth; });

        var fiveMinBefore = slot.minutes - 5;
        if (currentMinutes >= fiveMinBefore && currentMinutes < slot.minutes) {
          incomplete.forEach(function(d) {
            var key5 = d.name + '_5min_' + slot.time;
            if (tenkoNotifySent[key5]) return;
            var userId = lineMapping[d.name];
            if (userId && userId.indexOf('U') === 0) {
              var msg = '⚠️ 点呼リマインダー\n\n' + d.name + 'さん、着車時間 ' + slot.time + ' まであと5分です。\n点呼認証がまだ完了していません。\n\n🪪 免許証認証: ' + (d.licenseAuth ? '✅' : '❌') + '\n👨‍🏫 メンター認証: ' + (d.mentorAuth ? '✅' : '❌');
              pushTenkoNotify(userId, msg);
              tenkoNotifySent[key5] = true;
              addNotifyLog('driver', '📩', d.name + ' に5分前リマインダー送信');
            }
          });
        }

        if (currentMinutes >= slot.minutes) {
          var adminKey = 'admin_' + slot.time;
          if (!tenkoNotifySent[adminKey] && incomplete.length > 0) {
            var list = incomplete.map(function(d) {
              return '・' + d.name + '（🪪' + (d.licenseAuth ? '✅' : '❌') + ' 👨‍🏫' + (d.mentorAuth ? '✅' : '❌') + '）';
            }).join('\n');

            var adminMsg = '🚨 点呼未完了通知\n\n着車時間 ' + slot.time + ' を過ぎましたが、以下のドライバーの点呼が完了していません。\n\n' + list + '\n\n未完了: ' + incomplete.length + '名';

            pushTenkoNotify('__admin__', adminMsg);
            tenkoNotifySent[adminKey] = true;
            addNotifyLog('admin', '🚨', '着車 ' + slot.time + ' 未完了 ' + incomplete.length + '名 → 管理者通知');
          }
        }
      });

      renderNotifySlots();
    }

    async function pushTenkoNotify(to, text) {
      var proxyUrl = (lineSettings.gasProxyUrl || '').trim();
      if (!proxyUrl) return;
      try {
        await fetch(proxyUrl, {
          method: 'POST',
          mode: 'cors',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: to, messages: [{ type: 'text', text: text }] })
        });
      } catch(e) {
        console.error('点呼LINE通知エラー:', e);
      }
    }

    // Initialize
    renderDriverTable();
    initLineSettings();
    loadTenkoData();
    // 起動時にUI描画 + 3秒後にチェック
    setTimeout(function() { renderNotifySlots(); checkTenkoLineNotify(); refreshAllLineProfiles(); }, 3000);

    // ===== 請求照合機能 =====
    var billingData = [];
    var billingSent = {};

    function handleDropFile(event, type) {
      var file = event.dataTransfer.files[0];
      if (!file) return;
      if (!file.name.match(/\.xlsx?$/i)) { alert('Excelファイル(.xlsx/.xls)を選択してください'); return; }
      if (type === 'shift') {
        var fakeEvent = { target: { files: [file] } };
        handleShiftUpload(fakeEvent);
      } else if (type === 'billing') {
        var fakeEvent2 = { target: { files: [file] } };
        handleBillingUpload(fakeEvent2);
      }
    }

    function handleBillingUpload(event) {
      var file = event.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function(e) {
        var data = new Uint8Array(e.target.result);
        var workbook = XLSX.read(data, { type: 'array' });
        var sheet = workbook.Sheets[workbook.SheetNames[0]];
        var json = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        parseBillingData(json);
      };
      reader.readAsArrayBuffer(file);
    }

    function parseBillingData(rows) {
      billingData = [];
      billingSent = {};
      var startRow = 2;
      for (var h = 0; h < Math.min(rows.length, 5); h++) {
        if (rows[h] && rows[h].join && rows[h].join('').indexOf('宛名') >= 0) {
          startRow = h + 1;
          break;
        }
      }
      for (var i = startRow; i < rows.length; i++) {
        var row = rows[i];
        if (!row || !row[0]) continue;

        var driverKey = (row[0] || '').toString().trim();
        var name = (row[2] || '').toString().trim();
        if (!name) continue;

        var workDays = 0;
        for (var c = 3; c <= 10; c++) {
          var v = parseInt(row[c]) || 0;
          workDays += v;
        }

        var breakdown = [];
        var labels = ['11B', '8B', 'B1', 'B2', 'biker', '嘉麻応援', 'C1', 'C3'];
        for (var c2 = 3; c2 <= 10; c2++) {
          var v2 = parseInt(row[c2]) || 0;
          if (v2 > 0) breakdown.push(labels[c2 - 3] + ': ' + v2 + '日');
        }

        var sysUsageFlag = (row[11] || '').toString().trim();
        var sundayBonus = (row[12] || '').toString().trim();
        var charter = parseNum(row[13]);
        var mileage = parseNum(row[14]);
        var deduction = parseNum(row[15]);
        var subtotal = parseNum(row[16]);
        var tax = parseNum(row[17]);
        var sysUsageFee = parseNum(row[18]);
        var total = parseNum(row[19]);

        billingData.push({
          driverKey: driverKey,
          name: name,
          workDays: workDays,
          breakdown: breakdown,
          sysUsageFlag: sysUsageFlag,
          sysUsageFee: sysUsageFee,
          sundayBonus: sundayBonus,
          charter: charter,
          mileage: mileage,
          deduction: deduction,
          subtotal: subtotal,
          tax: tax,
          total: total,
          selected: true
        });
      }

      renderBillingTable();
      document.getElementById('billing-summary').classList.remove('hidden');
      document.getElementById('billing-actions').classList.remove('hidden');
      document.getElementById('billing-dropzone').classList.add('hidden');
    }

    function parseNum(val) {
      if (!val) return 0;
      var s = val.toString().replace(/[¥,\s]/g, '');
      return parseInt(s) || 0;
    }

    function formatYen(n) {
      if (n === 0) return '¥0';
      return '¥' + n.toLocaleString();
    }

    function renderBillingTable() {
      var tbody = document.getElementById('billing-table-body');
      if (!tbody) return;
      if (billingData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="12" class="text-center py-8 text-ink-lighter text-sm">請求Excelを読み込んでください</td></tr>';
        return;
      }

      var totalAmount = 0;
      var lineCount = 0;
      var selectedCount = 0;

      tbody.innerHTML = billingData.map(function(d, i) {
        totalAmount += d.total;
        var userId = findLineUserId(d.driverKey, d.name);
        var hasLine = userId && userId.indexOf('U') === 0;
        if (hasLine) lineCount++;
        if (d.selected) selectedCount++;

        var sent = billingSent[d.name];
        var statusHtml = sent
          ? '<span class="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">送信済</span>'
          : '<span class="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">未送信</span>';

        var lineHtml = hasLine
          ? '<span class="text-xs text-green-600">✅ 登録済</span>'
          : '<span class="text-xs text-gray-400">未登録</span>';

        return '<tr class="border-b border-border hover:bg-surface/50 ' + (sent ? 'opacity-60' : '') + '">' +
          '<td class="px-3 py-2"><input type="checkbox" ' + (d.selected ? 'checked' : '') + ' onchange="toggleBillingSelect(' + i + ', this.checked)" class="cursor-pointer"></td>' +
          '<td class="px-3 py-2 font-medium">' + d.name + '</td>' +
          '<td class="px-3 py-2 text-right">' + d.workDays + '日</td>' +
          '<td class="px-3 py-2 text-right">' + formatYen(d.charter) + '</td>' +
          '<td class="px-3 py-2 text-right">' + formatYen(d.mileage) + '</td>' +
          '<td class="px-3 py-2 text-right ' + (d.deduction < 0 ? 'text-red-600' : '') + '">' + formatYen(d.deduction) + '</td>' +
          '<td class="px-3 py-2 text-right">' + formatYen(d.subtotal) + '</td>' +
          '<td class="px-3 py-2 text-right">' + formatYen(d.tax) + '</td>' +
          '<td class="px-3 py-2 text-right">' + formatYen(d.sysUsageFee) + '</td>' +
          '<td class="px-3 py-2 text-right font-bold">' + formatYen(d.total) + '</td>' +
          '<td class="px-3 py-2 text-center">' + lineHtml + '</td>' +
          '<td class="px-3 py-2 text-center">' + statusHtml + '</td>' +
        '</tr>';
      }).join('');

      document.getElementById('billing-total-count').textContent = billingData.length;
      document.getElementById('billing-total-amount').textContent = formatYen(totalAmount);
      document.getElementById('billing-line-count').textContent = lineCount;
    }

    function toggleBillingSelect(index, checked) {
      billingData[index].selected = checked;
    }

    function findLineUserId(driverKey, name) {
      if (lineMapping[driverKey]) return lineMapping[driverKey];
      if (lineMapping[name]) return lineMapping[name];
      var cleanName = name.replace(/[\s　]/g, '');
      for (var key in lineMapping) {
        if (key.replace(/[\s　]/g, '') === cleanName) return lineMapping[key];
      }
      return null;
    }

    function buildBillingMessage(d) {
      var now = new Date();
      var monthStr = now.getFullYear() + '年' + (now.getMonth() + 1) + '月度';

      var msg = '📋 【' + monthStr + ' 請求金額のご確認】\n\n';
      msg += d.name + ' 様\n\n';
      msg += '━━━━━━━━━━━━━━━\n';
      msg += '■ 稼働実績\n';
      msg += '  稼働日数: ' + d.workDays + '日\n';
      if (d.breakdown.length > 0) {
        msg += '  内訳: ' + d.breakdown.join(', ') + '\n';
      }
      if (d.charter > 0) msg += '  チャーター料金: ' + formatYen(d.charter) + '\n';
      if (d.mileage > 0) msg += '  走行距離連動: ' + formatYen(d.mileage) + '\n';
      if (d.sysUsageFlag === '○') msg += '  システム使用料: あり\n';
      if (d.sundayBonus === '○') msg += '  日曜日手当: あり\n';
      if (d.deduction !== 0) msg += '  控除: ' + formatYen(d.deduction) + '\n';
      msg += '━━━━━━━━━━━━━━━\n';
      msg += '■ ご請求金額\n';
      msg += '  税別: ' + formatYen(d.subtotal) + '\n';
      msg += '  消費税: ' + formatYen(d.tax) + '\n';
      if (d.sysUsageFee > 0) msg += '  システム使用料: ' + formatYen(d.sysUsageFee) + '\n';
      msg += '  ━━━━━━━━━━━\n';
      msg += '  合計(税込): ' + formatYen(d.total) + '\n';
      msg += '━━━━━━━━━━━━━━━\n\n';
      msg += 'ご確認をお願いいたします。\n';
      msg += '内容に相違がある場合はご連絡ください。';

      return msg;
    }

    function escapeHtmlBilling(str) {
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function previewBillingMessage() {
      if (billingData.length === 0) { alert('請求データを読み込んでください'); return; }

      var existing = document.getElementById('billing-preview-modal');
      if (existing) existing.remove();

      var modal = document.createElement('div');
      modal.id = 'billing-preview-modal';
      modal.className = 'fixed inset-0 bg-black/50 flex items-center justify-center z-50';
      modal.style.cssText = 'overflow-y:auto;padding:20px';

      var selected = billingData.filter(function(d) { return d.selected; });
      if (selected.length === 0) selected = billingData;

      var tabsHtml = selected.map(function(d, i) {
        return '<button onclick="showBillingPreview(' + i + ')" id="bp-tab-' + i + '" class="text-xs px-3 py-1.5 rounded whitespace-nowrap cursor-pointer ' + (i === 0 ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200') + '">' + d.name + '</button>';
      }).join('');

      var firstMsg = buildBillingMessage(selected[0]);

      modal.innerHTML =
        '<div class="bg-white rounded-lg shadow-xl w-full max-w-lg mx-auto" style="max-height:90vh;display:flex;flex-direction:column">' +
          '<div class="flex items-center justify-between p-4 border-b border-border">' +
            '<h3 class="text-base font-bold">📋 メッセージテンプレート プレビュー</h3>' +
            '<button onclick="document.getElementById(\'billing-preview-modal\').remove()" class="text-gray-400 hover:text-gray-600 text-2xl cursor-pointer">&times;</button>' +
          '</div>' +
          '<div class="p-3 border-b border-border overflow-x-auto"><div class="flex gap-2" id="bp-tabs">' + tabsHtml + '</div></div>' +
          '<div class="p-4 flex-1 overflow-y-auto">' +
            '<div id="bp-message" class="bg-green-50 rounded-lg p-4 font-mono text-sm whitespace-pre-wrap leading-relaxed" style="max-height:60vh;overflow-y:auto">' + escapeHtmlBilling(firstMsg) + '</div>' +
          '</div>' +
          '<div class="p-3 border-t border-border flex justify-end gap-2">' +
            '<span class="text-xs text-ink-lighter self-center mr-auto">💡 このメッセージがLINEで送信されます</span>' +
            '<button onclick="document.getElementById(\'billing-preview-modal\').remove()" class="btn-secondary text-xs px-4 py-2 rounded cursor-pointer">閉じる</button>' +
          '</div>' +
        '</div>';

      document.body.appendChild(modal);
      window._billingPreviewData = selected;
    }

    function showBillingPreview(index) {
      var data = window._billingPreviewData;
      if (!data || !data[index]) return;
      var msg = buildBillingMessage(data[index]);
      document.getElementById('bp-message').textContent = msg;
      var tabs = document.getElementById('bp-tabs').children;
      for (var i = 0; i < tabs.length; i++) {
        tabs[i].className = i === index
          ? 'text-xs px-3 py-1.5 rounded whitespace-nowrap cursor-pointer bg-blue-500 text-white'
          : 'text-xs px-3 py-1.5 rounded whitespace-nowrap cursor-pointer bg-gray-100 text-gray-600 hover:bg-gray-200';
      }
    }

    async function sendAllBillingLine() {
      var proxyUrl = (lineSettings.gasProxyUrl || '').trim();
      if (!proxyUrl) { alert('LINE設定でProxy URLを設定してください'); return; }

      var targets = billingData.filter(function(d) {
        if (!d.selected) return false;
        if (billingSent[d.name]) return false;
        var userId = findLineUserId(d.driverKey, d.name);
        return userId && userId.indexOf('U') === 0;
      });

      if (targets.length === 0) {
        alert('送信対象がいません。\nLINE ID未登録か、既に送信済みです。');
        return;
      }

      if (!confirm(targets.length + '名にLINE送信します。\n\n' + targets.map(function(d) { return '・' + d.name + '（' + formatYen(d.total) + '）'; }).join('\n') + '\n\n送信しますか？')) return;

      document.getElementById('billing-send-log').classList.remove('hidden');
      var logEl = document.getElementById('billing-log-entries');

      var successCount = 0;
      for (var i = 0; i < targets.length; i++) {
        var d = targets[i];
        var userId = findLineUserId(d.driverKey, d.name);
        var msg = buildBillingMessage(d);

        try {
          await fetch(proxyUrl, {
            method: 'POST',
            mode: 'cors',
            credentials: 'omit',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to: userId, messages: [{ type: 'text', text: msg }] })
          });
          billingSent[d.name] = true;
          successCount++;
          var entry = document.createElement('div');
          entry.className = 'text-xs py-1 text-green-600';
          entry.textContent = new Date().toLocaleTimeString() + ' ✅ ' + d.name + ' → ' + formatYen(d.total) + ' 送信完了';
          logEl.insertBefore(entry, logEl.firstChild);
        } catch(e) {
          var entry2 = document.createElement('div');
          entry2.className = 'text-xs py-1 text-red-600';
          entry2.textContent = new Date().toLocaleTimeString() + ' ❌ ' + d.name + ' 送信失敗: ' + e.message;
          logEl.insertBefore(entry2, logEl.firstChild);
        }

        await new Promise(function(r) { setTimeout(r, 500); });
      }

      renderBillingTable();
      alert('送信完了: ' + successCount + '/' + targets.length + '名');
    }
  </script>
</body>
</html>
