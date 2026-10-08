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
 * Dictionary of localized messages and UI elements.
 */
const MESSAGES: Record<SupportedLanguage, Record<string, string>> = {
  en: {
    recoveredConversationsToast:
      '✅ [Antigravity Toolkit] Recovered {count} conversation(s) (interrupted by updates or migrations). To fully activate them in chat history, please reload the window.',
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
  },
  fa: {
    recoveredConversationsToast:
      '✅ [Antigravity Toolkit] تعداد {count} مکالمه بازیابی شد (قطع‌شده در آپدیت یا جابجایی). برای فعال‌سازی کامل در هیستوری چت، لطفاً پنجره را ریلود کنید.',
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
