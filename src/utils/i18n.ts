import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type SupportedLanguage =
  | 'en'
  | 'fa'
  | 'zh'
  | 'zh-TW'
  | 'ru'
  | 'es'
  | 'ja'
  | 'ko'
  | 'pt'
  | 'tr'
  | 'vi'
  | 'ar'
  | 'my';

/**
 * Normalizes language codes from Shield config or environment.
 */
export function normalizeLanguage(lang?: string | null): SupportedLanguage {
  if (!lang) return 'en';
  const clean = lang.trim().toLowerCase();

  if (clean === 'fa' || clean.startsWith('fa-') || clean === 'per' || clean === 'fas') return 'fa';
  if (clean === 'zh-tw' || clean === 'zh-hk' || clean === 'zh-hant') return 'zh-TW';
  if (clean.startsWith('zh')) return 'zh';
  if (clean.startsWith('ru')) return 'ru';
  if (clean.startsWith('es')) return 'es';
  if (clean.startsWith('ja')) return 'ja';
  if (clean.startsWith('ko')) return 'ko';
  if (clean.startsWith('pt')) return 'pt';
  if (clean.startsWith('tr')) return 'tr';
  if (clean.startsWith('vi')) return 'vi';
  if (clean.startsWith('ar')) return 'ar';
  if (clean.startsWith('my')) return 'my';

  return 'en';
}

/**
 * Reads preferred language directly from Antigravity Shield (~/.antigravity_shield/gui_config.json).
 * If not configured or unreadable, falls back to VS Code environment language, then 'en'.
 */
export function getActiveLanguage(): SupportedLanguage {
  try {
    const home = os.homedir();
    const configPath = path.join(home, '.antigravity_shield', 'gui_config.json');
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data.language === 'string' && data.language.trim()) {
        return normalizeLanguage(data.language);
      }
    }
  } catch {
    // fallback below
  }

  return normalizeLanguage(vscode.env.language);
}

/**
 * Determines whether the active language uses Right-to-Left (RTL) text direction.
 */
export function isRtlLanguage(lang?: SupportedLanguage): boolean {
  const l = lang || getActiveLanguage();
  return l === 'fa' || l === 'ar';
}

/**
 * Dictionary of localized messages and UI elements.
 */
const MESSAGES: Record<SupportedLanguage, Record<string, string>> = {
  en: {
    recoveredConversationsToast:
      '✅ [Antigravity Toolkit] Recovered {count} conversation(s) (interrupted by updates or migrations). To fully activate them in chat history, please reload the window.',
    fullSyncSuccessToast:
      '✅ [Antigravity Toolkit] Full recovery complete: {count} healthy conversation(s) synchronized & secured in vault. Please reload window to activate.',
    multiWindowWarning:
      'Multiple IDE windows detected. Please reload this window to apply history, and close other windows to prevent state overwrite.',
    singleConversationRecovered:
      'Conversation "{title}" was successfully recovered and added to history. Antigravity requires a window reload to fully activate it in the chat panel.',
    noInterruptedFound:
      'All conversations are healthy. No unindexed or interrupted sessions found.',
    reloadWindow: '🔄 Reload Window',
    later: 'Later',
    viewInEditor: '👁️ View in Editor',
    autoRecoverBtn: '⚡ Auto Recovery',
    autoRecoverTooltip:
      'Automatically recover interrupted or unindexed chats after an update or crash',
    recoveringBtn: '⏳ Recovering...',
    searchTitlesPlaceholder: 'Search conversation titles...',
    searchContentPlaceholder: 'Search conversation text...',
    switchedAccountToast: 'Switched from {from} to {to} due to token exhaustion.',
    switchedAccountStatus: '⚡ Switched to {to} (Quota depleted)',
    tgGuideTitle: '📘 Telegram Bot Setup & Required Permissions:',
    tgGuideStep1_label: 'Create Bot in BotFather:',
    tgGuideStep1_desc: 'In Telegram, send /newbot to @BotFather and paste the token into the first field.',
    tgGuideStep2_label: 'Group Privacy Settings:',
    tgGuideStep2_desc: 'In @BotFather send /setprivacy, choose your bot, and set to Disable (so it can read prompt messages & voice notes inside topics).',
    tgGuideStep3_label: 'Enable Topics in Group:',
    tgGuideStep3_desc: 'In your Telegram supergroup settings, turn on Topics (must be enabled by the group owner).',
    tgGuideStep4_label: 'Promote Bot to Admin:',
    tgGuideStep4_desc: 'Add the bot to your group and grant Manage Topics and Send Messages permissions.',
    tgGuideStep5_label: 'Group ID / Pair:',
    tgGuideStep5_desc: 'Enter the supergroup ID (format: -100...) in field 3 or run /pair in your group.',
    testAlertBtn: '🚀 Test Alert',
    cfLaunchOpen: '🌐 Open in Browser',
    cfLaunchConnect: '⚡ 1-Click Launch & Connect',
  },
  fa: {
    recoveredConversationsToast:
      '✅ [Antigravity Toolkit] تعداد {count} مکالمه بازیابی شد (قطع‌شده در آپدیت یا جابجایی). برای فعال‌سازی کامل در هیستوری چت، لطفاً پنجره را ریلود کنید.',
    fullSyncSuccessToast:
      '✅ [Antigravity Toolkit] ریکاوری جامع انجام شد: {count} مکالمه با موفقیت همگام‌سازی و در خزانه ایمن‌سازی شدند. لطفاً پنجره را ریلود کنید.',
    multiWindowWarning:
      'چندین پنجره IDE باز است. برای فعال‌سازی کامل، این پنجره را ریلود کنید و جهت پیشگیری از تداخل، سایر پنجره‌ها را ببندید.',
    singleConversationRecovered:
      'مکالمه «{title}» با موفقیت بازیابی و به تاریخچه اضافه شد. انتی‌گراویتی برای فعال‌سازی کامل آن در پنل چت نیاز به یک بار ریلود پنجره دارد.',
    noInterruptedFound:
      'تمامی مکالمات در وضعیت عادی هستند و مکالمهٔ قطع‌شده‌ای یافت نشد.',
    reloadWindow: '🔄 ریلود پنجره (Reload Window)',
    later: 'بعداً',
    viewInEditor: '👁️ مشاهده متن در ادیتور',
    autoRecoverBtn: '⚡ ریکاوری خودکار',
    autoRecoverTooltip:
      'بازیابی خودکار مکالمات قطع‌شده و ایندکس‌نشده پس از آپدیت یا کرش',
    recoveringBtn: '⏳ ریکاوری...',
    searchTitlesPlaceholder: 'جستجو در عنوان مکالمات...',
    searchContentPlaceholder: 'جستجو در متن مکالمات...',
    switchedAccountToast: 'سوییچ شد از {from} به {to} بخاطر اتمام توکن',
    switchedAccountStatus: '⚡ سوییچ شد به {to} (اتمام توکن)',
    tgGuideTitle: '📘 راهنمای راه‌اندازی ربات و دسترسی‌های لازم:',
    tgGuideStep1_label: 'ساخت ربات در BotFather:',
    tgGuideStep1_desc: 'در تلگرام به @BotFather دستور /newbot را بفرستید و توکن را در فیلد اول قرار دهید.',
    tgGuideStep2_label: 'دسترسی خواندن پیام‌ها:',
    tgGuideStep2_desc: 'در @BotFather دستور /setprivacy را بزنید، ربات خود را انتخاب و روی Disable قرار دهید (تا بتواند پیام‌ها و وویس‌های داخل تاپیک را بشنود).',
    tgGuideStep3_label: 'فعال‌سازی تاپیک در گروه:',
    tgGuideStep3_desc: 'در یک گروه تلگرام، از منوی تنظیمات گزینه Topics را روشن کنید (ربات نمی‌تواند خودش گروه را تاپیکی کند؛ حتماً مالک گروه با اکانت شخصی باید آن را روشن کند).',
    tgGuideStep4_label: 'ادمین کردن ربات:',
    tgGuideStep4_desc: 'ربات را به گروه اضافه کرده و با دسترسی Manage Topics (مدیریت موضوع‌ها) و Send Messages ادمین کنید.',
    tgGuideStep5_label: 'شناسه گروه / اتصال:',
    tgGuideStep5_desc: 'شناسه سوپرگروه (با فرمت -100...) را در فیلد سوم وارد کنید یا در گروه دستور /pair را امتحان کنید.',
    testAlertBtn: '🚀 Test Alert (ارسال پیام تست)',
    cfLaunchOpen: '🌐 باز کردن در مرورگر',
    cfLaunchConnect: '⚡ اتصال خودکار (1-Click Connect)',
  },
  zh: {
    recoveredConversationsToast:
      '✅ [Antigravity Toolkit] 已恢复 {count} 个会话（因更新或迁移中断）。如需在聊天历史中完全启用，请重新加载窗口。',
    singleConversationRecovered:
      '会话 “{title}” 已成功恢复并添加到历史记录。Antigravity 需要重新加载窗口以在聊天面板中完全激活。',
    noInterruptedFound:
      '所有会话状态正常，未发现中断或未索引的会话。',
    reloadWindow: '🔄 重新加载窗口 (Reload Window)',
    later: '稍后',
    viewInEditor: '👁️ 在编辑器中查看',
    autoRecoverBtn: '⚡ 自动恢复',
    autoRecoverTooltip: '更新或崩溃后自动恢复中断或未索引的会话',
    recoveringBtn: '⏳ 恢复中...',
    searchTitlesPlaceholder: '搜索会话标题...',
    searchContentPlaceholder: '搜索对话内容...',
    switchedAccountToast: '已从 {from} 切换至 {to}（Token 配额已用尽）',
    switchedAccountStatus: '⚡ 已切换至 {to}（配额用尽）',
    tgGuideTitle: '📘 Telegram 机器人设置及所需权限说明：',
    tgGuideStep1_label: '在 BotFather 中创建机器人：',
    tgGuideStep1_desc: '在 Telegram 向 @BotFather 发送 /newbot，并将 Token 填入首个输入框。',
    tgGuideStep2_label: '读取消息权限：',
    tgGuideStep2_desc: '在 @BotFather 发送 /setprivacy，选择你的机器人并设为 Disable（以便其能读取话题内的消息与语音）。',
    tgGuideStep3_label: '群组启用话题：',
    tgGuideStep3_desc: '在 Telegram 超级群组设置中开启 Topics 话题功能（必须由群主账号开启）。',
    tgGuideStep4_label: '将机器人设为管理员：',
    tgGuideStep4_desc: '将机器人添加进群，并赋予 Manage Topics（管理话题）与 Send Messages 权限。',
    tgGuideStep5_label: '群组 ID / 配对：',
    tgGuideStep5_desc: '在第三个字段填入超级群组 ID（格式 -100...）或在群内发送 /pair。',
    testAlertBtn: '🚀 发送测试消息',
    cfLaunchOpen: '🌐 在浏览器中打开',
    cfLaunchConnect: '⚡ 一键启动与连接',
  },
  'zh-TW': {
    recoveredConversationsToast:
      '✅ [Antigravity Toolkit] 已復原 {count} 個對話（因更新或遷移中斷）。如需在聊天歷史中完全啟用，請重新載入視窗。',
    singleConversationRecovered:
      '對話 “{title}” 已成功復原並新增至歷史紀錄。Antigravity 需要重新載入視窗以在聊天面板中完全啟用。',
    noInterruptedFound:
      '所有對話狀態正常，未發現中斷或未建立索引的對話。',
    reloadWindow: '🔄 重新載入視窗 (Reload Window)',
    later: '稍後',
    viewInEditor: '👁️ 在編輯器中檢視',
    autoRecoverBtn: '⚡ 自動復原',
    autoRecoverTooltip: '更新或崩潰後自動復原中斷或未建立索引的對話',
    recoveringBtn: '⏳ 復原中...',
    searchTitlesPlaceholder: '搜尋對話標題...',
    searchContentPlaceholder: '搜尋對話內容...',
    switchedAccountToast: '已從 {from} 切換至 {to}（Token 配額已用盡）',
    switchedAccountStatus: '⚡ 已切換至 {to}（配額用盡）',
    tgGuideTitle: '📘 Telegram 機器人設定及所需權限說明：',
    tgGuideStep1_label: '在 BotFather 中建立機器人：',
    tgGuideStep1_desc: '在 Telegram 向 @BotFather 發送 /newbot，並將 Token 填入第一個輸入框。',
    tgGuideStep2_label: '讀取訊息權限：',
    tgGuideStep2_desc: '在 @BotFather 發送 /setprivacy，選擇你的機器人並設為 Disable（以便其能讀取話題內的訊息與語音）。',
    tgGuideStep3_label: '群組啟用話題：',
    tgGuideStep3_desc: '在 Telegram 超級群組設定中開啟 Topics 話題功能（必須由群主帳號開啟）。',
    tgGuideStep4_label: '將機器人設為管理員：',
    tgGuideStep4_desc: '將機器人加入群組，並授予 Manage Topics（管理話題）與 Send Messages 權限。',
    tgGuideStep5_label: '群組 ID / 配對：',
    tgGuideStep5_desc: '在第三個欄位填入超級群組 ID（格式 -100...）或在群內發送 /pair。',
    testAlertBtn: '🚀 發送測試訊息',
    cfLaunchOpen: '🌐 在瀏覽器中開啟',
    cfLaunchConnect: '⚡ 一鍵啟動與連線',
  },
  ru: {
    recoveredConversationsToast:
      '✅ [Antigravity Toolkit] Восстановлено бесед: {count} (прерванных обновлением или миграцией). Чтобы полностью активировать их в истории чата, перезагрузите окно.',
    singleConversationRecovered:
      'Беседа «{title}» успешно восстановлена и добавлена в историю. Для полной активации в панели чата требуется перезагрузить окно.',
    noInterruptedFound:
      'Все беседы в порядке. Прерванных или неиндексированных сессий не найдено.',
    reloadWindow: '🔄 Перезагрузить окно (Reload Window)',
    later: 'Позже',
    viewInEditor: '👁️ Просмотреть в редакторе',
    autoRecoverBtn: '⚡ Авто-восстановление',
    autoRecoverTooltip:
      'Автоматическое восстановление прерванных или неиндексированных бесед после обновления или сбоя',
    recoveringBtn: '⏳ Восстановление...',
    searchTitlesPlaceholder: 'Поиск по заголовкам...',
    searchContentPlaceholder: 'Поиск по содержимому...',
    switchedAccountToast: 'Переключено с {from} на {to} из-за исчерпания квоты.',
    switchedAccountStatus: '⚡ Переключено на {to} (квота исчерпана)',
    tgGuideTitle: '📘 Настройка бота Telegram и необходимые разрешения:',
    tgGuideStep1_label: 'Создать бота в BotFather:',
    tgGuideStep1_desc: 'В Telegram отправьте /newbot боту @BotFather и вставьте токен в первое поле.',
    tgGuideStep2_label: 'Разрешение на чтение сообщений:',
    tgGuideStep2_desc: 'В @BotFather отправьте /setprivacy, выберите бота и установите Disable (чтобы он мог принимать сообщения и голосовые).',
    tgGuideStep3_label: 'Включить темы (Topics) в группе:',
    tgGuideStep3_desc: 'В настройках супергруппы Telegram включите Topics (должно быть включено владельцем группы).',
    tgGuideStep4_label: 'Сделать бота администратором:',
    tgGuideStep4_desc: 'Добавьте бота в группу и выдайте разрешения Manage Topics (Управление темами) и Send Messages.',
    tgGuideStep5_label: 'ID группы / сопряжение:',
    tgGuideStep5_desc: 'Введите ID супергруппы (формат: -100...) в третье поле или отправьте /pair в группу.',
    testAlertBtn: '🚀 Тестовое оповещение',
    cfLaunchOpen: '🌐 Открыть в браузере',
    cfLaunchConnect: '⚡ Быстрый запуск и подключение',
  },
  es: {
    recoveredConversationsToast:
      '✅ [Antigravity Toolkit] Se recuperaron {count} conversación(es) (interrumpidas por actualizaciones o migración). Para activarlas por completo en el historial de chat, recarga la ventana.',
    singleConversationRecovered:
      'La conversación «{title}» se recuperó con éxito y se añadió al historial. Antigravity requiere recargar la ventana para activarla por completo en el panel de chat.',
    noInterruptedFound:
      'Todas las conversaciones están en buen estado. No se encontraron sesiones interrumpidas ni sin indexar.',
    reloadWindow: '🔄 Recargar ventana (Reload Window)',
    later: 'Más tarde',
    viewInEditor: '👁️ Ver en el editor',
    autoRecoverBtn: '⚡ Autorrecuperación',
    autoRecoverTooltip:
      'Recuperar automáticamente chats interrumpidos o no indexados tras una actualización o fallo',
    recoveringBtn: '⏳ Recuperando...',
    searchTitlesPlaceholder: 'Buscar títulos de conversaciones...',
    searchContentPlaceholder: 'Buscar texto de conversaciones...',
    switchedAccountToast: 'Cambiado de {from} a {to} debido al agotamiento de tokens.',
    switchedAccountStatus: '⚡ Cambiado a {to} (cuota agotada)',
    tgGuideTitle: '📘 Configuración del bot de Telegram y permisos necesarios:',
    tgGuideStep1_label: 'Crear bot en BotFather:',
    tgGuideStep1_desc: 'En Telegram, envía /newbot a @BotFather y pega el token en el primer campo.',
    tgGuideStep2_label: 'Permiso para leer mensajes:',
    tgGuideStep2_desc: 'En @BotFather envía /setprivacy, elige tu bot y configúralo en Disable (para que pueda escuchar mensajes y audios).',
    tgGuideStep3_label: 'Activar temas (Topics) en el grupo:',
    tgGuideStep3_desc: 'En la configuración del supergrupo de Telegram, activa Topics (debe ser activado por el propietario del grupo).',
    tgGuideStep4_label: 'Hacer administrador al bot:',
    tgGuideStep4_desc: 'Añade el bot al grupo y concédele permisos de Manage Topics y Send Messages.',
    tgGuideStep5_label: 'ID de grupo / Vincular:',
    tgGuideStep5_desc: 'Introduce el ID del supergrupo (formato: -100...) en el campo 3 o ejecuta /pair en el grupo.',
    testAlertBtn: '🚀 Alerta de prueba',
    cfLaunchOpen: '🌐 Abrir en navegador',
    cfLaunchConnect: '⚡ Iniciar y conectar en 1 clic',
  },
  ja: {
    recoveredConversationsToast:
      '✅ [Antigravity Toolkit] {count} 件の会話を復元しました（更新または移行により中断）。チャット履歴で完全に有効にするには、ウィンドウを再読み込みしてください。',
    singleConversationRecovered:
      '会話「{title}」が正常に復元され、履歴に追加されました。チャットパネルで完全に有効にするには、ウィンドウの再読み込みが必要です。',
    noInterruptedFound:
      'すべての会話は正常です。中断されたセッションや未登録のセッションは見つかりませんでした。',
    reloadWindow: '🔄 ウィンドウを再読み込み (Reload Window)',
    later: '後で',
    viewInEditor: '👁️ エディタで表示',
    autoRecoverBtn: '⚡ 自動復元',
    autoRecoverTooltip:
      '更新またはクラッシュ後に中断または未インデックスのチャットを自動復元します',
    recoveringBtn: '⏳ 復元中...',
    searchTitlesPlaceholder: '会話のタイトルを検索...',
    searchContentPlaceholder: '会話の本文を検索...',
    switchedAccountToast: 'トークン枯渇のため {from} から {to} に切り替えました。',
    switchedAccountStatus: '⚡ {to} に切り替えました（クォータ枯渇）',
    tgGuideTitle: '📘 Telegram ボットの設定と必要な権限：',
    tgGuideStep1_label: 'BotFather でボットを作成：',
    tgGuideStep1_desc: 'Telegram で @BotFather に /newbot を送信し、最初のフィールドにトークンを貼り付けます。',
    tgGuideStep2_label: 'メッセージ読み取り権限：',
    tgGuideStep2_desc: '@BotFather で /setprivacy を送信し、ボットを選択して Disable に設定します（トピック内のメッセージや音声を認識できるようにするため）。',
    tgGuideStep3_label: 'グループでトピックを有効化：',
    tgGuideStep3_desc: 'Telegram スーパーグループの設定で Topics をオンにします（グループ所有者自身が有効にする必要があります）。',
    tgGuideStep4_label: 'ボットを管理者にする：',
    tgGuideStep4_desc: 'ボットをグループに追加し、Manage Topics（トピック管理）と Send Messages の権限を付与します。',
    tgGuideStep5_label: 'グループ ID / ペアリング：',
    tgGuideStep5_desc: '3番目のフィールドにスーパーグループ ID（形式: -100...）を入力するか、グループで /pair を実行します。',
    testAlertBtn: '🚀 テスト送信',
    cfLaunchOpen: '🌐 ブラウザで開く',
    cfLaunchConnect: '⚡ ワンクリック起動と接続',
  },
  ko: {
    recoveredConversationsToast:
      '✅ [Antigravity Toolkit] {count}개의 대화가 복구되었습니다(업데이트 또는 마이그레이션으로 중단됨). 채팅 기록에서 완전히 활성화하려면 창을 다시 로드하세요.',
    singleConversationRecovered:
      '대화 "{title}"이(가) 성공적으로 복구되어 기록에 추가되었습니다. 채팅 패널에서 완전히 활성화하려면 창을 다시 로드해야 합니다.',
    noInterruptedFound:
      '모든 대화가 정상 상태입니다. 중단되거나 색인되지 않은 세션이 없습니다.',
    reloadWindow: '🔄 창 다시 로드 (Reload Window)',
    later: '나중에',
    viewInEditor: '👁️ 편집기에서 보기',
    autoRecoverBtn: '⚡ 자동 복구',
    autoRecoverTooltip:
      '업데이트 또는 충돌 후 중단되거나 색인되지 않은 대화를 자동으로 복구합니다',
    recoveringBtn: '⏳ 복구 중...',
    searchTitlesPlaceholder: '대화 제목 검색...',
    searchContentPlaceholder: '대화 내용 검색...',
    switchedAccountToast: '토큰 소진으로 인해 {from}에서 {to}(으)로 전환되었습니다.',
    switchedAccountStatus: '⚡ {to}(으)로 전환됨 (할당량 소진)',
    tgGuideTitle: '📘 Telegram 봇 설정 및 필수 권한 안내:',
    tgGuideStep1_label: 'BotFather에서 봇 생성:',
    tgGuideStep1_desc: 'Telegram에서 @BotFather에게 /newbot 명령을 보내고 첫 번째 입력란에 토큰을 붙여넣으세요.',
    tgGuideStep2_label: '메시지 읽기 권한:',
    tgGuideStep2_desc: '@BotFather에서 /setprivacy 명령을 실행하고 봇을 선택한 뒤 Disable로 설정하세요(토픽 내 프롬프트 및 음성 메모 인식용).',
    tgGuideStep3_label: '그룹 내 토픽 활성화:',
    tgGuideStep3_desc: 'Telegram 슈퍼그룹 설정에서 Topics를 켜세요(그룹 소유자가 직접 켜야 합니다).',
    tgGuideStep4_label: '봇을 관리자로 지정:',
    tgGuideStep4_desc: '봇을 그룹에 추가하고 Manage Topics 및 Send Messages 권한을 부여하세요.',
    tgGuideStep5_label: '그룹 ID / 페어링:',
    tgGuideStep5_desc: '3번째 필드에 슈퍼그룹 ID(-100... 형식)를 입력하거나 그룹에서 /pair를 실행하세요.',
    testAlertBtn: '🚀 테스트 알림',
    cfLaunchOpen: '🌐 브라우저에서 열기',
    cfLaunchConnect: '⚡ 1클릭 시작 및 연결',
  },
  pt: {
    recoveredConversationsToast:
      '✅ [Antigravity Toolkit] {count} conversa(s) recuperada(s) (interrompidas por atualização ou migração). Para ativá-las totalmente no histórico, recarregue a janela.',
    singleConversationRecovered:
      'A conversa "{title}" foi recuperada com sucesso e adicionada ao histórico. O Antigravity requer a recarga da janela para ativá-la totalmente no painel.',
    noInterruptedFound:
      'Todas as conversas estão saudáveis. Nenhuma sessão interrompida ou não indexada foi encontrada.',
    reloadWindow: '🔄 Recarregar Janela (Reload Window)',
    later: 'Mais tarde',
    viewInEditor: '👁️ Ver no Editor',
    autoRecoverBtn: '⚡ Recuperação Automática',
    autoRecoverTooltip:
      'Recupere automaticamente conversas interrompidas ou não indexadas após atualização ou falha',
    recoveringBtn: '⏳ Recuperando...',
    searchTitlesPlaceholder: 'Pesquisar títulos de conversas...',
    searchContentPlaceholder: 'Pesquisar texto de conversas...',
    switchedAccountToast: 'Alternado de {from} para {to} devido ao esgotamento de tokens.',
    switchedAccountStatus: '⚡ Alternado para {to} (cota esgotada)',
    tgGuideTitle: '📘 Configuração do bot do Telegram e permissões necessárias:',
    tgGuideStep1_label: 'Criar bot no BotFather:',
    tgGuideStep1_desc: 'No Telegram, envie /newbot para @BotFather e cole o token no primeiro campo.',
    tgGuideStep2_label: 'Permissão de leitura de mensagens:',
    tgGuideStep2_desc: 'No @BotFather envie /setprivacy, selecione seu bot e defina como Disable (para que possa ler mensagens e áudios).',
    tgGuideStep3_label: 'Ativar tópicos no grupo:',
    tgGuideStep3_desc: 'Nas configurações do supergrupo do Telegram, ative Topics (deve ser ativado pelo proprietário do grupo).',
    tgGuideStep4_label: 'Promover bot a administrador:',
    tgGuideStep4_desc: 'Adicione o bot ao grupo e conceda permissões de Manage Topics e Send Messages.',
    tgGuideStep5_label: 'ID do grupo / Pareamento:',
    tgGuideStep5_desc: 'Insira o ID do supergrupo (formato: -100...) no campo 3 ou execute /pair no grupo.',
    testAlertBtn: '🚀 Alerta de Teste',
    cfLaunchOpen: '🌐 Abrir no Navegador',
    cfLaunchConnect: '⚡ Iniciar e Conectar com 1 Clique',
  },
  tr: {
    recoveredConversationsToast:
      '✅ [Antigravity Toolkit] {count} sohbet kurtarıldı (güncelleme veya taşıma nedeniyle kesintiye uğramış). Sohbet geçmişinde tamamen etkinleştirmek için lütfen pencereyi yeniden yükleyin.',
    singleConversationRecovered:
      '"{title}" sohbeti başarıyla kurtarıldı ve geçmişe eklendi. Sohbet panelinde tam olarak etkinleştirmek için pencerenin yeniden yüklenmesi gerekir.',
    noInterruptedFound:
      'Tüm sohbetler normal durumda. Kesintiye uğramış veya dizine eklenmemiş oturum bulunamadı.',
    reloadWindow: '🔄 Pencereyi Yeniden Yükle (Reload Window)',
    later: 'Daha sonra',
    viewInEditor: '👁️ Düzenleyicide Görüntüle',
    autoRecoverBtn: '⚡ Otomatik Kurtarma',
    autoRecoverTooltip:
      'Güncelleme veya çökme sonrasında kesintiye uğrayan veya dizine eklenmemiş sohbetleri otomatik olarak kurtarın',
    recoveringBtn: '⏳ Kurtarılıyor...',
    searchTitlesPlaceholder: 'Sohbet başlıklarında ara...',
    searchContentPlaceholder: 'Sohbet metninde ara...',
    switchedAccountToast: 'Belirteç tükendiği için {from} yerine {to} hesabına geçildi.',
    switchedAccountStatus: '⚡ {to} hesabına geçildi (Kota tükendi)',
    tgGuideTitle: '📘 Telegram Bot Kurulumu ve Gerekli İzinler:',
    tgGuideStep1_label: 'BotFather ile Bot Oluşturma:',
    tgGuideStep1_desc: 'Telegram\'da @BotFather\'a /newbot komutunu gönderin ve belirteci ilk alana yapıştırın.',
    tgGuideStep2_label: 'Mesaj Okuma İzni:',
    tgGuideStep2_desc: '@BotFather içinde /setprivacy komutunu gönderin, botunuzu seçin ve Disable olarak ayarlayın.',
    tgGuideStep3_label: 'Grupta Konuları (Topics) Etkinleştir:',
    tgGuideStep3_desc: 'Telegram süper grup ayarlarında Topics özelliğini açın (grup sahibi tarafından açılmalıdır).',
    tgGuideStep4_label: 'Botu Yönetici Yap:',
    tgGuideStep4_desc: 'Botu gruba ekleyin ve Manage Topics ile Send Messages izinlerini verin.',
    tgGuideStep5_label: 'Grup Kimliği / Eşleme:',
    tgGuideStep5_desc: 'Üçüncü alana süper grup kimliğini (-100... biçiminde) girin veya grupta /pair komutunu çalıştırın.',
    testAlertBtn: '🚀 Test Uyarısı',
    cfLaunchOpen: '🌐 Tarayıcıda Aç',
    cfLaunchConnect: '⚡ 1 Tıkla Başlat ve Bağlan',
  },
  vi: {
    recoveredConversationsToast:
      '✅ [Antigravity Toolkit] Đã khôi phục {count} cuộc trò chuyện (bị gián đoạn do cập nhật hoặc di chuyển). Để kích hoạt hoàn toàn trong lịch sử trò chuyện, vui lòng tải lại cửa sổ.',
    singleConversationRecovered:
      'Cuộc trò chuyện "{title}" đã được khôi phục thành công và thêm vào lịch sử. Antigravity cần tải lại cửa sổ để kích hoạt hoàn toàn trong bảng trò chuyện.',
    noInterruptedFound:
      'Tất cả các cuộc trò chuyện đều bình thường. Không tìm thấy phiên nào bị gián đoạn hoặc chưa được lập chỉ mục.',
    reloadWindow: '🔄 Tải lại cửa sổ (Reload Window)',
    later: 'Để sau',
    viewInEditor: '👁️ Xem trong trình chỉnh sửa',
    autoRecoverBtn: '⚡ Tự động khôi phục',
    autoRecoverTooltip:
      'Tự động khôi phục các cuộc trò chuyện bị gián đoạn hoặc chưa được lập chỉ mục sau khi cập nhật hoặc sự cố',
    recoveringBtn: '⏳ Đang khôi phục...',
    searchTitlesPlaceholder: 'Tìm kiếm tiêu đề cuộc trò chuyện...',
    searchContentPlaceholder: 'Tìm kiếm nội dung cuộc trò chuyện...',
    switchedAccountToast: 'Đã chuyển từ {from} sang {to} do hết mã token.',
    switchedAccountStatus: '⚡ Đã chuyển sang {to} (Hết hạn mức)',
    tgGuideTitle: '📘 Hướng dẫn thiết lập bot Telegram và quyền cần thiết:',
    tgGuideStep1_label: 'Tạo bot trong BotFather:',
    tgGuideStep1_desc: 'Trong Telegram, gửi /newbot cho @BotFather và dán mã token vào trường đầu tiên.',
    tgGuideStep2_label: 'Quyền đọc tin nhắn:',
    tgGuideStep2_desc: 'Trong @BotFather gửi /setprivacy, chọn bot của bạn và đặt thành Disable.',
    tgGuideStep3_label: 'Bật Topics trong nhóm:',
    tgGuideStep3_desc: 'Trong cài đặt siêu nhóm Telegram, bật tính năng Topics (phải do chủ nhóm bật).',
    tgGuideStep4_label: 'Thăng cấp bot làm quản trị viên:',
    tgGuideStep4_desc: 'Thêm bot vào nhóm và cấp quyền Manage Topics cùng Send Messages.',
    tgGuideStep5_label: 'ID nhóm / Ghép nối:',
    tgGuideStep5_desc: 'Nhập ID siêu nhóm (định dạng: -100...) vào trường thứ 3 hoặc chạy /pair trong nhóm.',
    testAlertBtn: '🚀 Cảnh báo thử nghiệm',
    cfLaunchOpen: '🌐 Mở trong trình duyệt',
    cfLaunchConnect: '⚡ Khởi chạy và kết nối 1 cú nhấp',
  },
  ar: {
    recoveredConversationsToast:
      '✅ [Antigravity Toolkit] تم استرداد {count} محادثة (انقطعت بسبب التحديث أو النقل). لتفعيلها بالكامل في سجل الدردشة، يرجى إعادة تحميل النافذة.',
    singleConversationRecovered:
      'تم استرداد المحادثة "{title}" بنجاح وإضافتها إلى السجل. يتطلب Antigravity إعادة تحميل النافذة لتفعيلها بالكامل في لوحة الدردشة.',
    noInterruptedFound:
      'جميع المحادثات بحالة جيدة. لم يتم العثور على جلسات مقطوعة أو غير مفهرسة.',
    reloadWindow: '🔄 إعادة تحميل النافذة (Reload Window)',
    later: 'لاحقاً',
    viewInEditor: '👁️ عرض في المحرر',
    autoRecoverBtn: '⚡ استرداد تلقائي',
    autoRecoverTooltip:
      'استرداد المحادثات المقطوعة أو غير المفهرسة تلقائياً بعد التحديث أو الأعطال',
    recoveringBtn: '⏳ جارٍ الاسترداد...',
    searchTitlesPlaceholder: 'البحث في عناوين المحادثات...',
    searchContentPlaceholder: 'البحث في نصوص المحادثات...',
    switchedAccountToast: 'تم التحويل من {from} إلى {to} بسبب نفاد التوكنات.',
    switchedAccountStatus: '⚡ تم التحويل إلى {to} (نفاد الحصة)',
    tgGuideTitle: '📘 دليل إعداد بوت تيليجرام والصلاحيات المطلوبة:',
    tgGuideStep1_label: 'إنشاء بوت في BotFather:',
    tgGuideStep1_desc: 'في تيليجرام، أرسل الأمر /newbot إلى @BotFather وضع الرمز في الحقل الأول.',
    tgGuideStep2_label: 'صلاحية قراءة الرسائل:',
    tgGuideStep2_desc: 'في @BotFather أرسل /setprivacy، اختر بوتك واضبطه على Disable.',
    tgGuideStep3_label: 'تفعيل المواضيع (Topics) في المجموعة:',
    tgGuideStep3_desc: 'في إعدادات المجموعة الخارقة بتيليجرام، قم بتفعيل Topics (يجب تفعيلها بواسطة مالك المجموعة).',
    tgGuideStep4_label: 'ترقية البوت إلى مشرف:',
    tgGuideStep4_desc: 'أضف البوت إلى المجموعة وامنحه صلاحيتي Manage Topics و Send Messages.',
    tgGuideStep5_label: 'معرف المجموعة / الربط:',
    tgGuideStep5_desc: 'أدخل معرف المجموعة الخارقة (بالتنسيق: -100...) في الحقل الثالث أو جرب الأمر /pair في المجموعة.',
    testAlertBtn: '🚀 تنبيه تجريبي',
    cfLaunchOpen: '🌐 فتح في المتصفح',
    cfLaunchConnect: '⚡ تشغيل واتصال بنقرة واحدة',
  },
  my: {
    recoveredConversationsToast:
      '✅ [Antigravity Toolkit] Recovered {count} conversation(s). Please reload window to activate.',
    singleConversationRecovered:
      'Conversation "{title}" was successfully recovered. Antigravity requires a window reload to activate.',
    noInterruptedFound:
      'All conversations are healthy. No interrupted sessions found.',
    reloadWindow: '🔄 Reload Window',
    later: 'Later',
    viewInEditor: '👁️ View in Editor',
    autoRecoverBtn: '⚡ Auto Recovery',
    autoRecoverTooltip: 'Automatically recover interrupted chats',
    recoveringBtn: '⏳ Recovering...',
    searchTitlesPlaceholder: 'Search titles...',
    searchContentPlaceholder: 'Search text...',
    switchedAccountToast: 'Switched from {from} to {to} due to token exhaustion.',
    switchedAccountStatus: '⚡ Switched to {to} (Quota depleted)',
    tgGuideTitle: '📘 Telegram Bot Setup & Permissions:',
    tgGuideStep1_label: 'Create Bot in BotFather:',
    tgGuideStep1_desc: 'In Telegram, send /newbot to @BotFather and paste token into first field.',
    tgGuideStep2_label: 'Group Privacy Settings:',
    tgGuideStep2_desc: 'In @BotFather send /setprivacy, select bot, and set to Disable.',
    tgGuideStep3_label: 'Enable Topics in Group:',
    tgGuideStep3_desc: 'In group settings, enable Topics (must be enabled by owner).',
    tgGuideStep4_label: 'Promote Bot to Admin:',
    tgGuideStep4_desc: 'Add bot to group with Manage Topics and Send Messages permissions.',
    tgGuideStep5_label: 'Group ID / Pair:',
    tgGuideStep5_desc: 'Enter supergroup ID (-100...) in field 3 or run /pair in group.',
    testAlertBtn: '🚀 Test Alert',
    cfLaunchOpen: '🌐 Open in Browser',
    cfLaunchConnect: '⚡ 1-Click Launch & Connect',
  },
};

/**
 * Returns a translated string for the active language with optional variable interpolation.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const lang = getActiveLanguage();
  const langTable = MESSAGES[lang] || MESSAGES.en;
  let text = langTable[key] || MESSAGES.en[key] || key;

  if (params) {
    for (const [pKey, pVal] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${pKey}\\}`, 'g'), String(pVal));
    }
  }

  return text;
}
