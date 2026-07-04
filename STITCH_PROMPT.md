# Google Stitch Prompt

Design a powerful, premium-looking desktop UI for an Indonesian Telegram automation control panel. This is not a marketing site. It is an operational dashboard for daily use, built inside a desktop app window. The visual style should feel modern, sharp, reliable, and high-end, but must remain lightweight and fast to render.

Product name: Telegram Sender Control

Primary user:
- A single operator managing multiple Telegram accounts.
- The operator sends/forwards channel posts to selected groups, Telegram folders, and admin/owner contacts.
- The user needs fast scanning, strong status visibility, and clear controls to stop/pause/retry jobs.

Layout:
- Use a fixed left sidebar navigation, around 220-260px wide.
- Use a compact top bar with backend status, active account count, current jobs, and last sync time.
- Main content should use routed pages/sections, not one giant long page.
- Keep cards flat, compact, and professional. Border radius max 8px.
- Avoid heavy gradients, decorative blobs, hero sections, large illustrations, and marketing copy.
- UI must feel like a serious operations console, not a landing page.

Navigation sections:
1. Status Pengiriman
2. Target Grup
3. Folder Telegram
4. Admin / Owner
5. Pengaturan Blast
6. Interval Target
7. Log & Error
8. Akun Telegram
9. Mode HP / 24 Jam

Page 1: Status Pengiriman
- This is the default first screen.
- Show three lane cards at the top:
  - Grup Utama
  - Folder Grup
  - Admin / Owner
- Each lane card shows:
  - Running/Idle badge
  - Sender account avatar, phone, label
  - Current target
  - Last result
  - Progress percent
  - Next send countdown
  - Stop button for that lane
- Include a global stop button in the header area.
- Below lane cards, show three compact progress tables:
  - Grup Utama
  - Folder Grup
  - Admin / Owner
- Each table columns:
  - Target
  - Source account
  - Sender account
  - Status badge
  - Last sent time
  - Next countdown
  - Error reason
- Status badges:
  - Mengirim
  - Terkirim
  - Pending retry
  - Gagal
  - Siap
  - Nonaktif
- Countdown chips must be readable and update visually every second, but should be lightweight.

Page 2: Target Grup
- Controls:
  - Account selector
  - Detect Grup button
  - Search input
  - Select all
  - Clear
  - Save selected
- Show a virtualized-looking dense list/table of groups.
- Each row:
  - Checkbox
  - Group title
  - Username/public indicator
  - Type: Group/Supergroup/Channel
  - Detected from account
- Include a small non-blocking loading state: "Detect berjalan di background".

Page 3: Folder Telegram
- Controls:
  - Account selector
  - Detect folder account button
  - Folder dropdown
  - Search groups in selected folder
  - Select all
  - Save folder groups
- Show detected folders as small tabs or dropdown items with counts.
- Show only explicit groups inside selected Telegram folder, not all groups.
- Include settings directly on this page:
  - Sender account
  - Link post channel folder
  - Text fallback folder
  - Default interval
  - Delay between folder groups
  - Scheduler toggle
  - Loop toggle
  - Send folder now
  - Stop folder
- Make it obvious that Folder Grup has separate delay and message from Grup Utama.

Page 4: Admin / Owner
- Controls:
  - Detect admin/owner
  - Search
  - Select all
  - Select owner only
  - Clear
  - Save selected
- Dense table:
  - Name
  - Username
  - Role
  - Source groups
  - Detected from account
  - Bot filtered indicator

Page 5: Pengaturan Blast
- Split into three vertical settings panels:
  - Grup Utama
  - Folder Grup
  - Admin / Owner
- Grup Utama:
  - Sender account
  - Link post channel default
  - Text default grup
  - Default interval
  - Delay between groups
  - Scheduler toggle
  - Loop toggle
  - Send now
  - Stop
- Folder Grup:
  - Sender account
  - Link post channel folder
  - Text fallback folder
  - Default interval
  - Delay between folder groups
  - Scheduler toggle
  - Loop toggle
  - Send now
  - Stop folder
- Admin / Owner:
  - Sender account
  - Message text
  - Default interval
  - Delay between contacts
  - Scheduler toggle
  - Loop toggle
  - Send now

Page 6: Interval Target
- Editable dense table with tabs:
  - Grup Utama
  - Folder Grup
  - Admin / Owner
- Columns:
  - Target
  - Enabled toggle
  - Interval seconds
  - Custom message override
  - Last run
  - Next run
  - Countdown
  - Status
- Make editing fast and clear. Avoid large textareas unless row expanded.
- Provide Save intervals button sticky at bottom/top.

Page 7: Log & Error
- Log table:
  - Time
  - Mode
  - Target
  - Account
  - Result
  - Error reason
- Error reason should be readable, e.g. Flood wait, Privacy restricted, Peer flood, Network timeout, Session problem.
- Add filters: mode, success/error, search.

Page 8: Akun Telegram
- Account list with:
  - Avatar
  - Label
  - Phone
  - Login status
  - Active indicator
- Account form:
  - Label
  - API ID
  - API Hash
  - Phone
  - OTP
  - 2FA password
  - Save account
  - Send OTP
  - Login
- Must support multiple accounts clearly.

Page 9: Mode HP / 24 Jam
- Controls:
  - Quiet hours toggle
  - Quiet start time
  - Quiet end time
  - Network retry seconds
  - Auto reconnect toggle
- Show explanation visually, not long text:
  - Backend Android online/offline
  - Current LAN IP
  - Last reconnect result
  - Current quiet status

Design style:
- Professional SaaS dashboard.
- Use compact tables and status chips.
- Use restrained colors: neutral base, green for OK, amber for pending, red for error, blue for active sending.
- Do not make the UI one-color monotone.
- Avoid purple-blue gradient dominance.
- Use icons for buttons where useful:
  - Play/send
  - Stop
  - Refresh/detect
  - Save
  - Search
  - Settings
  - Alert
- Typography:
  - No giant text except app title/top page titles.
  - Compact readable sizes.
  - No negative letter spacing.
- Responsiveness:
  - Desktop target: 1280x820.
  - Must also work at 1024 width.
  - Tables can scroll internally.

Performance requirements:
- Design must be lightweight.
- Avoid heavy animations, background videos, SVG decoration, blur-heavy glassmorphism, large shadows.
- Use simple CSS transitions only.
- Large lists should look virtualized/paginated.
- Detect actions should show background progress and never block the UI.
- Countdown must update in the UI without requiring backend request every second.

Output expected from Stitch:
- Full page layout mockup.
- HTML/CSS-friendly structure.
- Clearly named sections and components.
- Keep Indonesian labels.
