# i18n 术语表（zh-CN / en-US / zh-TW / ja-JP / ko-KR）

> 职责：**多语言术语的唯一权威**（PRD `I18N-15` 的交付物）。新增语言或修订文案时以本表为准；
> `scripts/i18n_check.py` 会校验语言键集与占位符一致，术语一致性由翻译评审按本表逐条核对。
> 实现约定见 `docs/architecture/clklog-analytics-design-i18n-v1.md`；资源位置见 `apps/analytics-web/src/i18n/locales/`。

## 使用规则

1. **同一概念在所有语言中只能有一种译法**；修改本表需同步修订已发布的资源（并跑 `i18n_check.py`）。
2. **专有名词不译**：`ClkLog`、`ClickHouse`、`Kafka`、`SQL`、`API Key`、`Harness`、`AI Workspace`、`Debug`、`webhook`、`Bot`、`NestJS`、`Prisma`。
3. **技术标识不译**：`sa_events`、`clklog_sa`、`sa_datatable_rows`、`distinct_id`、`user_key`、`track_signup`、`percent_0_100`、字段枚举值（`value` 字段）等。
4. **代码示例 / SQL 片段 / URL / 正则**原样保留；`{{占位符}}` 在译文中的名字与数量必须与源语言一致。
5. 语言自称（`简体中文` / `English` / `繁體中文` / `日本語` / `한국어`）在任何语言下都不翻译。

## 1. 产品与分析域

| zh-CN | en-US | zh-TW | ja-JP | ko-KR | ru-RU | fr-FR | de-DE |
|---|---|---|---|---|---|---|---|
| 埋点 | tracking plan | 埋點 | トラッキング | 트래킹 | плана трекинга | plan de tracking | Tracking-Plan |
| 事件 | event | 事件 | イベント | 이벤트 | событие | événement | Ereignis |
| 属性 | property | 屬性 | プロパティ | 속성 | свойство | propriété | Eigenschaft |
| 用户属性 | user property | 使用者屬性 | ユーザープロパティ | 사용자 속성 | свойство пользователя | propriété utilisateur | Benutzereigenschaft |
| 事件属性 | event attribute | 事件屬性 | イベントプロパティ | 이벤트 속성 | атрибут события | attribut d'événement | Ereignisattribut |
| 虚拟事件 | virtual event | 虛擬事件 | 仮想イベント | 가상 이벤트 | виртуальное событие | événement virtuel | virtuelles Ereignis |
| 虚拟属性 | virtual property | 虛擬屬性 | 仮想プロパティ | 가상 속성 | виртуальное свойство | propriété virtuelle | virtuelle Eigenschaft |
| 元数据 | metadata | 中繼資料 | メタデータ | 메타데이터 | метаданные | métadonnées | Metadaten |
| 分析主体 | analysis subject | 分析主體 | 分析主体 | 분석 주체 | субъект анализа | sujet d'analyse | Analyse-Subjekt |
| 事件分析 | event analysis | 事件分析 | イベント分析 | 이벤트 분석 | анализ событий | analyse d'événements | Ereignisanalyse |
| 漏斗 | funnel | 漏斗 | ファネル | 퍼널 | воронка | entonnoir | Funnel |
| 留存 | retention | 留存 | リテンション | 리텐션 | удержание | rétention | Retention |
| 留存率 | retention rate | 留存率 | リテンション率 | 리텐션율 | доля удержания | taux de rétention | Retentionsrate |
| 转化率 | conversion rate | 轉換率 | コンバージョン率 | 전환율 | конверсия | taux de conversion | Konversionsrate |
| 看板 | dashboard | 看板 | ダッシュボード | 대시보드 | дашборд | tableau de bord | Dashboard |
| 卡片 | card | 卡片 | カード | 카드 | карточка | carte | Karte |
| 分群 | cohort | 分群 | コホート | 코호트 | когорта | cohorte | Kohorte |
| 标签 | tag | 標籤 | タグ | 태그 | тег | étiquette | Tag |
| 指标 | metric | 指標 | 指標 | 지표 | метрика | métrique | Metrik |
| 口径 | definition | 口徑 | 定義 | 정의 | определение | définition | Definition |
| 去重 | distinct | 去重 | ユニーク | 중복 제거 | уникальные | distinct | distinct |
| 人均 | per user | 人均 | ユーザーあたり | 사용자당 | на пользователя | par utilisateur | pro Benutzer |
| 时间范围 | time range | 時間範圍 | 期間 | 기간 | период | période | Zeitraum |
| 粒度 | granularity | 粒度 | 粒度 | 세분화 단위 | гранулярность | granularité | Granularität |
| 分组 | group by | 分組 | グループ | 그룹 | группировка | regroupement | Gruppierung |
| 筛选 | filter | 篩選 | フィルター | 필터 | фильтр | filtre | Filter |
| 数据表 | data table | 資料表 | データテーブル | 데이터 테이블 | таблица данных | table de données | Datentabelle |
| 字段 | column / field | 欄位 | カラム | 컬럼 | поле | champ | Feld |
| 绑定 | binding | 綁定 | バインド | 바인딩 | привязка | liaison | Bindung |
| 物化 | materialize | 物化 | マテリアライズ | 구체화 | материализация | matérialisation | Materialisierung |
| 快照 | snapshot | 快照 | スナップショット | 스냅샷 | снимок | instantané | Snapshot |
| 租约 | lease | 租約 | リース | 임대 | аренда | bail | Lease |

## 2. 告警与运维域

| zh-CN | en-US | zh-TW | ja-JP | ko-KR | ru-RU | fr-FR | de-DE |
|---|---|---|---|---|---|---|---|
| 告警 | alert | 告警 | アラート | 알림 | оповещение | alerte | Alarm |
| 告警规则 | alert rule | 告警規則 | アラートルール | 알림 규칙 | правило оповещения | règle d'alerte | Alarmregel |
| 触发 | fire | 觸發 | 発火 | 발생 | срабатывание | déclenchement | Auslösung |
| 恢复 | resolve | 恢復 | 復旧 | 복구 | восстановление | rétablissement | Wiederherstellung |
| 屏蔽 | mute | 靜音 | ミュート | 음소거 | отключение уведомлений | mise en sourdine | Stummschaltung |
| 联系人 | contact | 聯絡人 | 連絡先 | 연락처 | контакт | contact | Kontakt |
| 通道 | channel | 通道 | チャンネル | 채널 | канал | canal | Kanal |
| 模板 | template | 範本 | テンプレート | 템플릿 | шаблон | modèle | Vorlage |
| 占位符 | placeholder | 佔位符 | プレースホルダー | 플레이스홀더 | плейсхолдер | paramètre fictif | Platzhalter |
| 阈值 | threshold | 閾值 | しきい値 | 임계값 | порог | seuil | Schwellenwert |
| 窗口 | window | 視窗 | ウィンドウ | 윈도우 | окно | fenêtre | Fenster |
| 健康度 | health | 健康度 | ヘルス | 상태 | работоспособность | état de santé | Zustand |
| 级别 | severity | 級別 | 重大度 | 심각도 | уровень | niveau | Schweregrad |
| 通知记录 | notifications | 通知記錄 | 通知履歴 | 알림 기록 | журнал уведомлений | historique des notifications | Benachrichtigungsverlauf |
| 保留策略 | retention policy | 保留策略 | 保持ポリシー | 보존 정책 | политика хранения | politique de rétention | Aufbewahrungsrichtlinie |
| 慢查询 | slow query | 慢查詢 | スロークエリ | 슬로우 쿼리 | медленный запрос | requête lente | langsame Abfrage |
| 服务器状态 | server status | 伺服器狀態 | サーバー状態 | 서버 상태 | состояние сервера | état du serveur | Serverstatus |
| 磁盘 | disk | 磁碟 | ディスク | 디스크 | диск | disque | Datenträger |
| 内存 | memory | 記憶體 | メモリ | 메모리 | память | mémoire | Arbeitsspeicher |
| 分区 | partition | 分割區 | パーティション | 파티션 | раздел | partition | Partition |
| 日志清理 | log cleanup | 日誌清理 | ログ整理 | 로그 정리 | очистка журналов | nettoyage des journaux | Protokollbereinigung |
| 预演 | dry run | 預演 | ドライラン | 사전 실행 | пробный прогон | simulation | Probelauf |
| 审计 | audit | 稽核 | 監査 | 감사 | аудит | audit | Audit |
| 质量 | quality | 品質 | 品質 | 품질 | качество | qualité | Qualität |
| 对拍 | reconcile | 對帳 | 突合 | 대조 | сверка | rapprochement | Abgleich |

## 3. 权限与账号域

| zh-CN | en-US | zh-TW | ja-JP | ko-KR | ru-RU | fr-FR | de-DE |
|---|---|---|---|---|---|---|---|
| 项目 | project | 專案 | プロジェクト | 프로젝트 | проект | projet | Projekt |
| 成员 | member | 成員 | メンバー | 멤버 | участник | membre | Mitglied |
| 成员组 | member group | 成員群組 | メンバーグループ | 멤버 그룹 | группа участников | groupe de membres | Mitgliedergruppe |
| 角色 | role | 角色 | ロール | 역할 | роль | rôle | Rolle |
| 权限 | permission | 權限 | 権限 | 권한 | права | autorisation | Berechtigung |
| 数据权限 | data policy | 資料權限 | データポリシー | 데이터 정책 | политика доступа к данным | politique de données | Datenrichtlinie |
| 项目 owner | project owner | 專案擁有者 | プロジェクトオーナー | 프로젝트 소유자 | Владелец проекта | Propriétaire du projet | Projekt-Owner |
| 分析管理员 | analysis admin | 分析管理員 | 分析管理者 | 분석 관리자 | Администратор анализа | Administrateur d'analyse | Analyse-Administrator |
| 分析师 | analyst | 分析師 | アナリスト | 분석가 | Аналитик | Analyste | Analyst |
| 普通成员 | member | 一般成員 | 一般メンバー | 일반 멤버 | Участник | Membre | Mitglied |
| 外部人员 | external | 外部人員 | 外部ユーザー | 외부 사용자 | Внешний пользователь | Utilisateur externe | Externer Benutzer |
| 平台超管 | platform admin | 平台超級管理員 | プラットフォーム管理者 | 플랫폼 관리자 | администратор платформы | super administrateur | Plattform-Administrator |
| 账号 | account | 帳號 | アカウント | 계정 | учётная запись | compte | Konto |
| 密码 | password | 密碼 | パスワード | 비밀번호 | пароль | mot de passe | Passwort |
| 登录 | sign in | 登入 | ログイン | 로그인 | Войти | Connexion | Anmelden |
| 退出登录 | sign out | 登出 | ログアウト | 로그아웃 | Выйти | Déconnexion | Abmelden |

## 4. 通用界面词汇

| zh-CN | en-US | zh-TW | ja-JP | ko-KR | ru-RU | fr-FR | de-DE |
|---|---|---|---|---|---|---|---|
| 保存 | Save | 儲存 | 保存 | 저장 | Сохранить | Enregistrer | Speichern |
| 取消 | Cancel | 取消 | キャンセル | 취소 | Отмена | Annuler | Abbrechen |
| 删除 | Delete | 刪除 | 削除 | 삭제 | Удалить | Supprimer | Löschen |
| 编辑 | Edit | 編輯 | 編集 | 편집 | Изменить | Modifier | Bearbeiten |
| 新建 | New | 新增 | 新規作成 | 새로 만들기 | Создать | Créer | Neu |
| 添加 | Add | 新增 | 追加 | 추가 | Добавить | Ajouter | Hinzufügen |
| 确定 | OK | 確定 | OK | 확인 | ОК | OK | OK |
| 关闭 | Close | 關閉 | 閉じる | 닫기 | Закрыть | Fermer | Schließen |
| 刷新 | Refresh | 重新整理 | 再読み込み | 새로 고침 | Обновить | Actualiser | Aktualisieren |
| 重试 | Retry | 重試 | 再試行 | 다시 시도 | Повторить | Réessayer | Wiederholen |
| 搜索 | Search | 搜尋 | 検索 | 검색 | Поиск | Rechercher | Suchen |
| 重置 | Reset | 重設 | リセット | 초기화 | Сбросить | Réinitialiser | Zurücksetzen |
| 清空 | Clear | 清除 | クリア | 지우기 | Очистить | Effacer | Leeren |
| 复制 | Copy | 複製 | コピー | 복사 | Копировать | Copier | Kopieren |
| 导出 | Export | 匯出 | エクスポート | 내보내기 | Экспорт | Exporter | Exportieren |
| 导入 | Import | 匯入 | インポート | 가져오기 | Импорт | Importer | Importieren |
| 返回 | Back | 返回 | 戻る | 뒤로 | Назад | Retour | Zurück |
| 提交 | Submit | 送出 | 送信 | 제출 | Отправить | Envoyer | Absenden |
| 应用 | Apply | 套用 | 適用 | 적용 | Применить | Appliquer | Anwenden |
| 查看 | View | 檢視 | 表示 | 보기 | Просмотр | Voir | Ansehen |
| 预览 | Preview | 預覽 | プレビュー | 미리보기 | Предпросмотр | Aperçu | Vorschau |
| 更多 | More | 更多 | その他 | 더보기 | Ещё | Plus | Mehr |
| 上传 | Upload | 上傳 | アップロード | 업로드 | Загрузить | Téléverser | Hochladen |
| 下载 | Download | 下載 | ダウンロード | 다운로드 | Скачать | Télécharger | Herunterladen |
| 名称 | Name | 名稱 | 名前 | 이름 | Название | Nom | Name |
| 描述 | Description | 描述 | 説明 | 설명 | Описание | Description | Beschreibung |
| 备注 | Notes | 備註 | メモ | 비고 | Примечание | Remarque | Notiz |
| 状态 | Status | 狀態 | ステータス | 상태 | Статус | Statut | Status |
| 类型 | Type | 類型 | タイプ | 유형 | Тип | Type | Typ |
| 操作 | Actions | 操作 | 操作 | 작업 | Действия | Actions | Aktionen |
| 创建时间 | Created at | 建立時間 | 作成日時 | 생성 시간 | Создано | Créé le | Erstellt am |
| 更新时间 | Updated at | 更新時間 | 更新日時 | 수정 시간 | Обновлено | Mis à jour le | Aktualisiert am |
| 暂无数据 | No data | 暫無資料 | データがありません | 데이터 없음 | Нет данных | Aucune donnée | Keine Daten |
| 加载中 | Loading… | 載入中… | 読み込み中… | 로딩 중… | Загрузка… | Chargement… | Wird geladen… |
| 已启用 | Enabled | 已啟用 | 有効 | 사용 중 | Включено | Activé | Aktiviert |
| 已禁用 | Disabled | 已停用 | 無効 | 사용 중지 | Отключено | Désactivé | Deaktiviert |
| 已隐藏 | Hidden | 已隱藏 | 非表示 | 숨김 | Скрыто | Masqué | Ausgeblendet |
| 待确认 | Pending confirmation | 待確認 | 確認待ち | 확인 대기 | Ожидает подтверждения | En attente | Ausstehend |
| 是 / 否 | Yes / No | 是 / 否 | はい / いいえ | 예 / 아니오 | Да / Нет | Oui / Non | Ja / Nein |
| 默认 | Default | 預設 | デフォルト | 기본 | По умолчанию | Par défaut | Standard |
| 自定义 | Custom | 自訂 | カスタム | 사용자 지정 | Настраиваемый | Personnalisé | Benutzerdefiniert |
| 全部 | All | 全部 | すべて | 전체 | Все | Tous | Alle |
| 数据 | Data | 資料 | データ | 데이터 | данные | données | Daten |
| 信息 | information | 資訊 | 情報 | 정보 | информация | informations | Information |
| 网络 | network | 網路 | ネットワーク | 네트워크 | сеть | réseau | Netzwerk |
| 视频 | video | 影片 | 動画 | 동영상 | видео | vidéo | Video |
| 文件 | file | 檔案 | ファイル | 파일 | файл | fichier | Datei |
| 目录 / 文件夹 | folder | 資料夾 | フォルダー | 폴더 | папка | dossier | Ordner |
| 页面 | page | 頁面 | ページ | 페이지 | страница | page | Seite |
| 优化 | Optimize | 最佳化 | 最適化 | 최적화 | Оптимизировать | Optimiser | Optimieren |
| 支持 | support | 支援 | 対応 | 지원 | поддержка | prise en charge | Unterstützung |
| 定时 | scheduled | 排程 | スケジュール | 예약 | по расписанию | planifié | geplant |
| 并发 | concurrency | 並行 | 同時実行 | 동시성 | параллелизм | concurrence | Parallelität |
| 进程 | process | 行程 | プロセス | 프로세스 | процесс | processus | Prozess |

## 5. 新增语言时的检查清单

1. `apps/analytics-web/src/i18n/config.ts` 的 `LOCALES` 加一行（`tag` / `label`（自称）/ `antd` / `dayjs` / `intl`）。
2. `apps/analytics-web/src/i18n/LocaleBridge.tsx` 的 `ANTD_LOCALES` 与 `dayjs/locale/*` 导入补齐（antd 未覆盖的语言回退 `en_US`）。
3. `apps/analytics-server/src/i18n/locales.ts` 的 `SUPPORTED_LOCALE_TAGS` 同步。
4. 新增 `locales/<tag>/`（16 个命名空间）与 `apps/analytics-server/src/i18n/messages/<tag>.json`。
5. `python3 scripts/i18n_check.py`（键集 / 占位符 / 非源语言无 CJK 残留）+ `python3 scripts/i18n_scan.py --check`。
6. 浏览器实测：语言选择器出现该语言、切换后壳层与三个代表页无源语言残留、`<html lang>` 与标题同步。
7. 全文按本表核对术语；**RTL 语言**（ar/he）另需先做 CSS 逻辑属性改造（未支持）。

## 6. 各语言特殊约定（新增语言时必须照做）

| 语言 | 复数（i18next 后缀） | 排版 | 其他 |
|---|---|---|---|
| `zh-CN` / `zh-TW` | 只用基础键（无形态变化） | 全形标点；繁中用台灣用語（使用者／平臺／資料／登入／儲存／範本／佇列／對帳） | 繁中禁简体专用字（`i18n_check.py` 有 558 字黑名单） |
| `ja-JP` | 只用基础键 | 日文全角（`。、：「」（）`）；数值与 `%` 半角 | 用日本字形（発火／復旧／重大度） |
| `ko-KR` | 只用基础键 | 句末 `다.`，顿号用 `,`，不用中文全角标点 | 助词（은/는、이/가、을/를）按前字有无收音选择；占位符后避免直接接助词 |
| `ru-RU` | **`_one` / `_few` / `_many` / `_other`**（1 / 2–4 / 5–20 / 其余） | `«»` 引号、`—` 破折号 | 敬称小写 `вы`；`common:unit.minute` 固定写拉丁 `min`（与图表量级判据相关，见下） |
| `fr-FR` | **`_one`（0 与 1） / `_other`** | `:` `?` `!` `;` 与 `%` 前用**不换行空格 U+00A0**；引号 `«\u00A0…\u00A0»`；千分位用空格 | B2B 一律 **vous**；日期 dd/MM |
| `de-DE` | **`_one` / `_other`** | 引号 `„…“`；名词首字母大写 | B2B 一律 **Sie**；**文本膨胀 30–50%**，按钮/标签取短词（`Neu`/`Konto`/`Betrieb`），复合词避让 |

**基础键规则**：无论哪种语言，**基础键都必须保留**（数字插值的兜底形态，如 `{{count}} Einträge`）；带复数形态的语言在其上追加变体即可。中/日/韩不写变体。

**量级判据**：`features/visualization/metric-units.ts` 用 `currentLocale().startsWith('zh')` 判断是否走「万/亿」，**不要**再用某条译文当判据（历史坑：曾用 `unit.minute !== 'min'`，俄语翻译成 `мин` 时会误判成中文量级）。

## 7. 第二批语言术语（es / pt / vi / th / id）

> 与第 1–5 节的 8 语表同源：中文概念一致，按各语言习惯落地。**新增键时先查这两张表**再动手。

| zh-CN | en-US | es-ES | pt-BR | vi-VN | th-TH | id-ID |
|---|---|---|---|---|---|---|
| 事件 | event | evento | evento | sự kiện | เหตุการณ์ | peristiwa |
| 属性 | property | propiedad | propriedade | thuộc tính | คุณสมบัติ | properti |
| 用户属性 | user property | propiedad de usuario | propriedade do usuário | thuộc tính người dùng | คุณสมบัติผู้ใช้ | properti pengguna |
| 事件属性 | event attribute | atributo de evento | atributo de evento | thuộc tính sự kiện | คุณสมบัติเหตุการณ์ | atribut peristiwa |
| 虚拟事件 | virtual event | evento virtual | evento virtual | sự kiện ảo | เหตุการณ์เสมือน | peristiwa virtual |
| 元数据 | metadata | metadatos | metadados | siêu dữ liệu | เมทาดาทา | metadata |
| 漏斗 | funnel | embudo | funil | phễu | กรวย | funnel |
| 留存 | retention | retención | retenção | giữ chân | การคงอยู่ | retensi |
| 留存率 | retention rate | tasa de retención | taxa de retenção | tỷ lệ giữ chân | อัตราการคงอยู่ | tingkat retensi |
| 转化率 | conversion rate | tasa de conversión | taxa de conversão | tỷ lệ chuyển đổi | อัตราการแปลง | tingkat konversi |
| 看板 | dashboard | panel | painel | bảng điều khiển | แดชบอร์ด | dasbor |
| 卡片 | card | tarjeta | cartão | thẻ | การ์ด | kartu |
| 分群 | cohort | cohorte | coorte | nhóm người dùng | กลุ่มผู้ใช้ | kohort |
| 标签 | tag | etiqueta | tag | thẻ | แท็ก | tag |
| 指标 | metric | métrica | métrica | chỉ số | ตัวชี้วัด | metrik |
| 告警 | alert | alerta | alerta | cảnh báo | การแจ้งเตือน | peringatan |
| 屏蔽 | mute | silenciar | silenciar | tắt thông báo | ปิดการแจ้งเตือน | senyapkan notifikasi |
| 联系人 | contact | contacto | contato | liên hệ | ผู้ติดต่อ | kontak |
| 通道 | channel | canal | canal | kênh | ช่องทาง | saluran |
| 模板 | template | plantilla | modelo | mẫu | เทมเพลต | templat |
| 项目 | project | proyecto | projeto | dự án | โปรเจกต์ | proyek |
| 成员 | member | miembro | membro | thành viên | สมาชิก | anggota |
| 角色 | role | rol | função | vai trò | บทบาท | peran |
| 权限 | permission | permiso | permissão | quyền | สิทธิ์ | izin |
| 保存 | Save | Guardar | Salvar | Lưu | บันทึก | Simpan |
| 登录 | Sign in | Iniciar sesión | Entrar | Đăng nhập | เข้าสู่ระบบ | Masuk |
| 退出登录 | Sign out | Cerrar sesión | Sair | Đăng xuất | ออกจากระบบ | Keluar |
| 设置 | Settings | Ajustes | Configurações | Cài đặt | การตั้งค่า | Pengaturan |
| 删除 | Delete | Eliminar | Excluir | Xóa | ลบ | Hapus |
| 搜索 | Search | Buscar | Pesquisar | Tìm kiếm | ค้นหา | Cari |
| 筛选 | Filter | Filtro | Filtro | Bộ lọc | ตัวกรอง | Filter |
| 数据 | data | datos | dados | dữ liệu | ข้อมูล | data |
| 信息 | information | información | informação | thông tin | ข้อมูลข่าวสาร | informasi |
| 账号 | account | cuenta | conta | tài khoản | บัญชี | akun |
| 默认 | default | predeterminado | padrão | mặc định | ค่าเริ่มต้น | bawaan |
| 加载中 | Loading… | Cargando… | Carregando… | Đang tải… | กำลังโหลด… | Memuat… |
| 服务器 | server | servidor | servidor | máy chủ | เซิร์ฟเวอร์ | server |
| 磁盘 | disk | disco | disco | ổ đĩa | ดิสก์ | disk |
| 内存 | memory | memoria | memória | bộ nhớ | หน่วยความจำ | memori |
| 分区 | partition | partición | partição | phân vùng | พาร์ทิชัน | partisi |
| 导出 | Export | Exportar | Exportar | Xuất | ส่งออก | Ekspor |
| 导入 | Import | Importar | Importar | Nhập | นำเข้า | Impor |
| 复制 | Copy | Copiar | Copiar | Sao chép | คัดลอก | Salin |
| 编辑 | Edit | Editar | Editar | Chỉnh sửa | แก้ไข | Edit |
| 新建 | New | Crear | Criar | Tạo mới | สร้าง | Buat |
| 阈值 | threshold | umbral | limite | ngưỡng | เกณฑ์ | ambang |
| 窗口 | window | ventana | janela | cửa sổ | หน้าต่าง | jendela |
| 快照 | snapshot | instantánea | instantâneo | ảnh chụp nhanh | สแนปช็อต | snapshot |
| 队列 | queue | cola | fila | hàng đợi | คิว | antrean |
| 实时 | real time | tiempo real | tempo real | thời gian thực | เรียลไทม์ | waktu nyata |
| 触发 | fire | activación | disparo | kích hoạt | การทริกเกอร์ | pemicuan |
| 恢复 | resolve | recuperación | recuperação | khôi phục | การกู้คืน | pemulihan |
| 慢查询 | slow query | consulta lenta | consulta lenta | truy vấn chậm | คิวรีช้า | kueri lambat |
| 审计 | audit | auditoría | auditoria | kiểm toán | การตรวจสอบ | audit |

**第二批的语言规则**：

| 语言 | 复数 | 排版 / 语域 | 其他 |
|---|---|---|---|
| `es-ES` | `_one` / `_other` | `¿`/`¡` 开头；`« »` 或 `“ ”` 统一其一；千分位 `.`、小数 `,` | `usted` 中性敬称；按钮不定式 |
| `pt-BR` | `_one` / `_other` | `“ ”`；千分位 `.`、小数 `,` | `você`；按钮不定式 |
| `vi-VN` | 只用基础键 | `“ ”`；越南语比英语长 20–40% | 按钮取短词；自然越语语序 |
| `th-TH` | 只用基础键 | **词内不空格**（正字法）；句间用空格；少用句号 | 串长且无词间空格 → 浏览器不易折行，按钮/标签务必短 |
| `id-ID` | 只用基础键 | `“ ”`；正式中性语域 | `Anda` 指用户；按钮用动词原形 |
