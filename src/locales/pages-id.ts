import type { Locale } from "../i18n";

const replacements: ReadonlyArray<readonly [string, string]> = [
  ["Durable AI conversation memory", "Memori percakapan AI yang tahan lama"],
  ["DURABLE AI CONVERSATION MEMORY", "MEMORI PERCAKAPAN AI YANG TAHAN LAMA"],
  [
    "Keep the context.<span>Continue the thought.</span>",
    "Simpan konteksnya.<span>Lanjutkan pemikirannya.</span>",
  ],
  [
    "Your next session shouldn’t start from zero. Keep original conversations, recall what matters, and pick up where you left off.",
    "Sesi berikutnya tidak harus dimulai dari nol. Simpan percakapan asli, ingat kembali hal penting, dan lanjutkan dari tempat Anda berhenti.",
  ],
  ["Read the thinking behind it", "Baca pemikiran di baliknya"],
  ["Interactive memory example", "Contoh memori interaktif"],
  ["Explore the memory lifecycle", "Jelajahi siklus hidup memori"],
  ["ILLUSTRATIVE EXAMPLE", "CONTOH ILUSTRATIF"],
  ["01 Save", "01 Simpan"],
  ["02 Find", "02 Temukan"],
  ["03 Continue", "03 Lanjutkan"],
  [
    "“Keep the decision, not just the summary.”",
    "“Simpan keputusannya, bukan hanya ringkasannya.”",
  ],
  [
    "Save the original conversation with its context. A new revision preserves what was said.",
    "Simpan percakapan asli beserta konteksnya. Revisi baru mempertahankan apa yang disampaikan.",
  ],
  ["“Why did we choose object storage?”", "“Mengapa kita memilih penyimpanan objek?”"],
  [
    "Search words and meaning with namespace and tag filters. Each compact reference points back to a canonical conversation and source range; stable snapshot pages preserve the ranked order.",
    "Cari kata dan makna dengan filter namespace dan tag. Setiap referensi ringkas merujuk kembali ke percakapan kanonis dan rentang sumber; halaman snapshot yang stabil mempertahankan urutan peringkat.",
  ],
  ["“Right. Let’s build on that.”", "“Baik. Mari lanjutkan dari sana.”"],
  [
    "Bring the surrounding messages into the next session. Verify the source before continuing the work.",
    "Bawa pesan-pesan terkait ke sesi berikutnya. Verifikasi sumber sebelum melanjutkan pekerjaan.",
  ],
  ["Original context. Not invented history.", "Konteks asli. Bukan riwayat rekaan."],
  ["YOUR MCP ENDPOINT", "ENDPOINT MCP ANDA"],
  ["Copy MCP endpoint", "Salin endpoint MCP"],
  ["Copy endpoint", "Salin endpoint"],
  ["EMAIL-ONLY ACCESS", "AKSES HANYA DENGAN EMAIL"],
  ["One email. No password.", "Satu email. Tanpa kata sandi."],
  [
    "MemPersist sends a one-use magic link to your email. Existing archives reopen automatically, and a new archive is created after the first link is opened. The same email always reconnects you to the same private memory archive.",
    "MemPersist mengirim tautan ajaib sekali pakai ke email Anda. Arsip yang ada terbuka kembali secara otomatis, dan arsip baru dibuat setelah tautan pertama dibuka. Email yang sama selalu menghubungkan Anda kembali ke arsip memori privat yang sama.",
  ],
  ["Passwordless access flow", "Alur akses tanpa kata sandi"],
  ["Enter your email", "Masukkan email Anda"],
  ["Open the magic link", "Buka tautan ajaib"],
  ["Return to your archive", "Kembali ke arsip Anda"],
  ["Connect ChatGPT", "Hubungkan ChatGPT"],
  [
    "MemPersist is not in the official ChatGPT plugin catalog. Connect it as a custom MCP app from Developer mode — the same endpoint works with every other MCP client too:",
    "MemPersist belum tersedia di katalog plugin resmi ChatGPT. Hubungkan sebagai aplikasi MCP khusus dari mode Pengembang — endpoint yang sama juga bekerja dengan klien MCP lain:",
  ],
  [
    "Open ChatGPT and go to <strong>Settings → Developer</strong>.",
    "Buka ChatGPT lalu masuk ke <strong>Settings → Developer</strong>.",
  ],
  [
    "Select <strong>Custom MCP app</strong> (or enable Developer mode and add a custom app).",
    "Pilih <strong>Custom MCP app</strong> (atau aktifkan mode Pengembang dan tambahkan aplikasi khusus).",
  ],
  ["Paste the endpoint:", "Tempel endpoint:"],
  [
    "Complete the OAuth prompt and enter your email. Existing archives reconnect automatically; a new archive is created after the first link is opened.",
    "Selesaikan permintaan OAuth dan masukkan email Anda. Arsip yang ada terhubung kembali secara otomatis; arsip baru dibuat setelah tautan pertama dibuka.",
  ],
  [
    "A one-use magic link is sent to your email. No password is created or stored, and the same email reconnects you to the same archive on any client.",
    "Tautan ajaib sekali pakai dikirim ke email Anda. Tidak ada kata sandi yang dibuat atau disimpan, dan email yang sama menghubungkan Anda ke arsip yang sama pada klien apa pun.",
  ],
  ["Connect coding agents", "Hubungkan agen pemrograman"],
  [
    "Then authorize with your email through the one-use magic-link flow:",
    "Kemudian beri otorisasi dengan email Anda melalui alur tautan ajaib sekali pakai:",
  ],
  [
    "Complete the OAuth prompt with your email. If you reconnect later, request a fresh magic link; your archive remains tied to the same email. Codex CLI, ChatGPT desktop, and the IDE extension share the same Codex configuration.",
    "Selesaikan permintaan OAuth dengan email Anda. Jika terhubung kembali nanti, minta tautan ajaib baru; arsip tetap terikat pada email yang sama. Codex CLI, ChatGPT desktop, dan ekstensi IDE berbagi konfigurasi Codex yang sama.",
  ],
  ["Any other MCP client", "Klien MCP lainnya"],
  [
    "Point any client that supports remote Streamable HTTP MCP servers at the endpoint above and authorize with your email through the magic-link flow. Cursor, JetBrains, VS Code extensions, and custom tooling all work the same way.",
    "Arahkan klien yang mendukung server MCP Streamable HTTP jarak jauh ke endpoint di atas dan beri otorisasi dengan email melalui alur tautan ajaib. Cursor, JetBrains, ekstensi VS Code, dan perangkat khusus bekerja dengan cara yang sama.",
  ],
  ["Memory conventions", "Konvensi memori"],
  [
    "For coding agents, keep memory organized and reviewable:",
    "Untuk agen pemrograman, jaga agar memori teratur dan mudah ditinjau:",
  ],
  [
    "Store into <code>project/&lt;slug&gt;</code> namespaces — the first write claims the name for your account.",
    "Simpan ke namespace <code>project/&lt;slug&gt;</code> — penulisan pertama mengklaim nama tersebut untuk akun Anda.",
  ],
  [
    "Record architecture decisions, breaking changes, deploy behavior changes, and incident root causes; skip routine commits.",
    "Catat keputusan arsitektur, perubahan yang memutus kompatibilitas, perubahan perilaku deployment, dan akar penyebab insiden; lewati commit rutin.",
  ],
  [
    "Search first (<code>memory_search</code>), verify with <code>memory_get_context</code>, then <code>memory_append</code> instead of duplicating.",
    "Cari dahulu (<code>memory_search</code>), verifikasi dengan <code>memory_get_context</code>, lalu gunakan <code>memory_append</code> alih-alih menduplikasi.",
  ],
  [
    "Delete only on explicit user confirmation (<code>memory_delete_conversations</code> or <code>memory_empty_namespace</code>).",
    "Hapus hanya dengan konfirmasi pengguna yang tegas (<code>memory_delete_conversations</code> atau <code>memory_empty_namespace</code>).",
  ],
  [
    "Never invent memory; cite the conversation and revision ids returned by the tools.",
    "Jangan pernah mengarang memori; kutip ID percakapan dan revisi yang dikembalikan alat.",
  ],
  ["Tools", "Alat"],
  ["Use", "Kegunaan"],
  [
    "find ranked memories; namespace + tags/tag_mode filters; stable opaque snapshot pagination",
    "temukan memori berperingkat; filter namespace + tags/tag_mode; pagination snapshot opak yang stabil",
  ],
  ["original messages around a hit", "pesan asli di sekitar hasil"],
  ["page a full conversation", "tampilkan percakapan lengkap per halaman"],
  [
    "start with 1–20 requests; resume fairly with one opaque cursor",
    "mulai dengan 1–20 permintaan; lanjutkan secara adil dengan satu kursor opak",
  ],
  [
    "<code>memory_get_conversations</code> accepts exactly one of <code>requests</code> (the first call) or an opaque <code>cursor</code> (continuations), plus optional <code>max_serialized_bytes</code>: default 32,768, minimum 4,096, maximum 49,152. Responses report <code>batchId</code>, ordered <code>results</code>, <code>completed</code>, <code>remaining</code>, <code>nextCursor</code>, <code>usedSerializedBytes</code>, and <code>maxSerializedBytes</code>; UTF-8 JSON stays within the requested budget and the 49,152-byte ceiling. Current revisions are pinned before bodies load, so cursor pages never mix concurrent writes; individual errors remain isolated and whole compact messages are admitted in deterministic round-robin order. Loop with <code>{ cursor: nextCursor }</code> until <code>nextCursor</code> is null. Per-item continuations remain for compatibility. Oversized messages return bounded conversation/revision/source-node/offset/byte metadata without text and advance cursor state; recover complete content through an authorized canonical HTTP read or account export.",
    "<code>memory_get_conversations</code> menerima tepat salah satu dari <code>requests</code> (panggilan pertama) atau <code>cursor</code> opak (kelanjutan), serta <code>max_serialized_bytes</code> opsional: default 32.768, minimum 4.096, maksimum 49.152. Respons melaporkan <code>batchId</code>, <code>results</code> berurutan, <code>completed</code>, <code>remaining</code>, <code>nextCursor</code>, <code>usedSerializedBytes</code>, dan <code>maxSerializedBytes</code>; JSON UTF-8 tetap berada dalam anggaran yang diminta dan batas 49.152 byte. Revisi saat ini dipatok sebelum isi dimuat, sehingga halaman kursor tidak pernah mencampur penulisan bersamaan; setiap kesalahan tetap terisolasi dan pesan ringkas utuh diterima secara adil dalam urutan round-robin deterministik. Ulangi dengan <code>{ cursor: nextCursor }</code> sampai <code>nextCursor</code> bernilai null. Kelanjutan per-item tetap tersedia untuk kompatibilitas. Pesan yang terlalu besar mengembalikan metadata percakapan/revisi/node sumber/offset/byte yang dibatasi tanpa teks dan memajukan state kursor; pulihkan konten lengkap melalui pembacaan HTTP kanonis yang terotorisasi atau ekspor akun.",
  ],
  [
    "<code>memory_search</code> accepts <code>query</code>, namespace and tag filters, <code>limit</code>, and optional <code>max_serialized_bytes</code> on the first call. If more results remain, continue with only an opaque <code>cursor</code> plus page and byte limits; the tenant-bound snapshot pins the ranking version, order, scores, and revision references. Compact references stay within the requested UTF-8 JSON budget. Snapshots expire automatically; deleted or no-longer-owned candidates are omitted with bounded safe reasons, and preserved <code>degraded</code>/<code>unavailable</code> diagnostics explain retrieval failures. Continuations cannot change the original filters.",
    "<code>memory_search</code> menerima <code>query</code>, filter namespace dan tag, <code>limit</code>, serta <code>max_serialized_bytes</code> opsional pada panggilan pertama. Jika masih ada hasil, lanjutkan hanya dengan <code>cursor</code> opak serta batas halaman dan byte; snapshot yang terikat tenant mempertahankan versi peringkat, urutan, skor, dan referensi revisi. Referensi ringkas tetap berada dalam anggaran JSON UTF-8 yang diminta. Snapshot kedaluwarsa secara otomatis; kandidat yang dihapus atau tidak lagi dimiliki dikeluarkan dengan alasan aman yang dibatasi, dan diagnosis <code>degraded</code>/<code>unavailable</code> yang dipertahankan menjelaskan kegagalan pengambilan. Filter asli tidak dapat diubah saat melanjutkan.",
  ],
  ["metadata and tags", "metadata dan tag"],
  ["namespaces your account owns", "namespace milik akun Anda"],
  ["counts and indexing health", "jumlah dan kesehatan pengindeksan"],
  [
    "returns runtime limits, search pagination, and degradation contract",
    "mengembalikan batas runtime, pagination pencarian, dan kontrak degradasi",
  ],
  ["durable new memory", "memori baru yang tahan lama"],
  [
    "extend a conversation, optimistic revision check",
    "perpanjang percakapan, pemeriksaan revisi optimistis",
  ],
  [
    "atomically append/replace 1–20 conversations with explicit base revisions",
    "menambahkan/mengganti 1–20 percakapan secara atomis dengan revisi dasar eksplisit",
  ],
  ["import progress, duplicate, or failure", "progres impor, duplikat, atau kegagalan"],
  ["change tags", "ubah tag"],
  [
    "atomic upsert of 1–100 keyed messages; insert/update/no-op with required base revision",
    "upsert atomik 1–100 pesan berkunci; penyisipan/pembaruan/tanpa-perubahan dengan revisi dasar wajib",
  ],
  ["delete specific memories (confirmed)", "hapus memori tertentu (dikonfirmasi)"],
  ["empty one namespace (exact confirmation)", "kosongkan satu namespace (konfirmasi persis)"],
  ["Privacy and isolation", "Privasi dan isolasi"],
  [
    "Namespaces are scoped per account: the same namespace name in another account is separate and invisible. Every tool only ever sees the namespaces your account owns. Raw and canonical conversation bodies live in private object storage; D1 holds only the catalog and disposable search data.",
    "Namespace dibatasi per akun: nama namespace yang sama pada akun lain tetap terpisah dan tidak terlihat. Setiap alat hanya melihat namespace milik akun Anda. Isi percakapan mentah dan kanonis berada di penyimpanan objek privat; D1 hanya menyimpan katalog dan data pencarian yang dapat dibangun ulang.",
  ],
  ["Designing durable AI conversation memory", "Merancang memori percakapan AI yang tahan lama"],
  [
    "MemPersist treats memory as a first-class archive: canonical, versioned, rebuildable, and explicitly written — not scraped.",
    "MemPersist memperlakukan memori sebagai arsip kelas utama: kanonis, berversi, dapat dibangun ulang, dan ditulis secara eksplisit — bukan dikikis otomatis.",
  ],
  ["Problem", "Masalah"],
  ["Principles", "Prinsip"],
  ["Storage model", "Model penyimpanan"],
  ["Multi-account isolation", "Isolasi multi-akun"],
  ["Retrieval", "Pengambilan"],
  ["Trust boundaries", "Batas kepercayaan"],
  ["How search works", "Cara kerja pencarian"],
  ["Scope and limitations", "Cakupan dan batasan"],
  [
    'AI sessions are ephemeral. Context windows reset, exports are static snapshots, and every new session re-derives what previous sessions already decided. The result is repeated work, invented history, and decisions that drift. Existing "memory" features are either opaque, non-portable, or scrape conversations the user never intended to persist.',
    'Sesi AI bersifat sementara. Jendela konteks diatur ulang, ekspor hanya cuplikan statis, dan setiap sesi baru menyimpulkan ulang keputusan sesi sebelumnya. Akibatnya pekerjaan berulang, riwayat rekaan, dan keputusan yang menyimpang. Fitur "memori" yang ada cenderung tidak transparan, tidak portabel, atau mengambil percakapan yang tidak pernah dimaksudkan pengguna untuk disimpan.',
  ],
  ["Intentional writes.", "Penulisan yang disengaja."],
  ["Canonical first.", "Kanonis lebih dahulu."],
  ["Disposable derived data.", "Data turunan dapat dibuang."],
  ["Deterministic identity.", "Identitas deterministik."],
  [
    "Hybrid retrieval combines lexical FTS, semantic vector search, and a bounded recent-canonical fallback for unindexed writes. Ranking fuses the channels deterministically and reports degraded channels instead of silently returning partial results.",
    "Pengambilan hibrida menggabungkan FTS leksikal, pencarian vektor semantik, dan fallback kanonis terbaru yang terbatas untuk penulisan yang belum diindeks. Pemeringkatan menggabungkan kanal secara deterministik dan melaporkan kanal yang menurun alih-alih diam-diam mengembalikan hasil parsial.",
  ],
  [
    "Hybrid retrieval combines lexical FTS, semantic vector search, and a bounded recent-canonical fallback for unindexed writes. Namespace and tag filters apply before ranked results are exposed; stable opaque snapshots preserve ranking across pages, while degraded channels remain visible instead of silently returning partial results.",
    "Pengambilan hibrida menggabungkan FTS leksikal, pencarian vektor semantik, dan fallback kanonis terbaru yang terbatas untuk penulisan yang belum diindeks. Filter namespace dan tag diterapkan sebelum hasil berperingkat ditampilkan; snapshot opak yang stabil mempertahankan peringkat antarhalaman, sementara kanal yang menurun tetap terlihat alih-alih diam-diam mengembalikan hasil parsial.",
  ],
  [
    "A query flows through three independent retrieval channels that are fused and ranked in one pass:",
    "Kueri mengalir melalui tiga kanal pengambilan independen yang digabungkan dan diperingkat dalam satu proses:",
  ],
  ["Cloudflare-native, clean-room", "Cloudflare-native, clean-room"],
  ["Cloudflare services", "Layanan Cloudflare"],
  ["Service", "Layanan"],
  ["Role", "Peran"],
  ["Module map", "Peta modul"],
  ["Module", "Modul"],
  ["Responsibility", "Tanggung jawab"],
  ["Invariants", "Invarian"],
  ["Stack", "Tumpukan teknologi"],
  [
    "Everything runs on Cloudflare Workers — no external infrastructure. R2 holds canonical truth, D1 is the catalog, derived indexes are rebuildable, and OAuth-protected MCP sits on top.",
    "Semuanya berjalan di Cloudflare Workers — tanpa infrastruktur eksternal. R2 menyimpan kebenaran kanonis, D1 menjadi katalog, indeks turunan dapat dibangun ulang, dan MCP yang dilindungi OAuth berada di atasnya.",
  ],
  ["Threat model and controls", "Model ancaman dan kontrol"],
  ["Controls", "Kontrol"],
  ["Isolation", "Isolasi"],
  [
    "MemPersist holds sensitive conversation history. The primary risks are unauthorized reads/writes, leaked tokens or magic links, mailbox compromise, malicious imports, oversized input, log leakage, and accidental canonical deletion.",
    "MemPersist menyimpan riwayat percakapan sensitif. Risiko utama mencakup pembacaan atau penulisan tanpa izin, kebocoran token atau tautan ajaib, kompromi kotak surat, impor berbahaya, masukan terlalu besar, kebocoran log, dan penghapusan data kanonis secara tidak sengaja.",
  ],
  [
    "Channel results are merged by deterministic chunk identity, then every candidate is verified against the caller's <code>(user_id, namespace)</code> scope before ranking. The final score combines lexical position, semantic similarity, and recency evidence; <code>memory_search</code> can return compact, revision-pinned references through a tenant-bound opaque snapshot. Expired snapshots and no-longer-owned candidates are handled safely, and channel failure remains visible as degraded.",
    "Hasil kanal digabungkan berdasarkan identitas chunk yang deterministik, lalu setiap kandidat diverifikasi terhadap cakupan <code>(user_id, namespace)</code> pemanggil sebelum diperingkat. Skor akhir menggabungkan posisi leksikal, kemiripan semantik, dan bukti keterkinian; <code>memory_search</code> dapat mengembalikan referensi ringkas yang dipatok ke revisi melalui snapshot opak yang terikat tenant. Snapshot kedaluwarsa dan kandidat yang tidak lagi dimiliki ditangani dengan aman, sementara kegagalan kanal tetap terlihat sebagai degraded.",
  ],
  ["Architecture decision records", "Catatan keputusan arsitektur"],
  ["ARCHITECTURE DECISION RECORDS", "CATATAN KEPUTUSAN ARSITEKTUR"],
  ["Accepted decisions", "Keputusan yang diterima"],
  [
    "Every significant architecture decision is recorded as an ADR with status and context. Accepted history is never rewritten; new decisions supersede old ones.",
    "Setiap keputusan arsitektur penting dicatat sebagai ADR beserta status dan konteksnya. Riwayat yang diterima tidak pernah ditulis ulang; keputusan baru menggantikan keputusan lama.",
  ],
  ["Find a decision", "Cari keputusan"],
  ["Search by topic or number…", "Cari berdasarkan topik atau nomor…"],
  ["Clear", "Bersihkan"],
  ["decisions", "keputusan"],
  ["Decision", "Keputusan"],
  ["Status", "Status"],
  ["Accepted", "Diterima"],
  ["No matching decisions", "Tidak ada keputusan yang cocok"],
  [
    "Tenant-bound memory-search snapshots and opaque cursors",
    "Snapshot memory-search yang terikat tenant dan kursor opak",
  ],
  [
    "Try “storage”, “OAuth”, or a decision number. Clear the search to see everything.",
    "Coba “penyimpanan”, “OAuth”, atau nomor keputusan. Bersihkan pencarian untuk melihat semuanya.",
  ],
  ["ABOUT", "TENTANG"],
  [
    "Software engineer building AI systems, distributed backends, and engineering tools. Based in Indonesia.",
    "Insinyur perangkat lunak yang membangun sistem AI, backend terdistribusi, dan alat rekayasa. Berbasis di Indonesia.",
  ],
  ["Creator of MemPersist", "Pembuat MemPersist"],
  ["Also working on", "Juga mengerjakan"],
  ["Find me", "Temukan saya"],
  [
    "MemPersist is designed around a simple idea: AI memory should be durable, explicit, and portable. It stores high-fidelity conversation history on Cloudflare, rebuilds derived search indexes from canonical data, and exposes itself to any MCP-compatible client through OAuth-protected Streamable HTTP.",
    "MemPersist dirancang berdasarkan gagasan sederhana: memori AI harus tahan lama, eksplisit, dan portabel. MemPersist menyimpan riwayat percakapan berketelitian tinggi di Cloudflare, membangun ulang indeks pencarian turunan dari data kanonis, dan tersedia bagi klien yang kompatibel dengan MCP melalui Streamable HTTP yang dilindungi OAuth.",
  ],
  [
    "a desktop simulation and flight-software workbench for an aerospace project.",
    "meja kerja simulasi desktop dan perangkat lunak penerbangan untuk proyek dirgantara.",
  ],
  [
    "AI systems, distributed backends, and engineering tooling across personal and client work.",
    "Sistem AI, backend terdistribusi, dan perangkat rekayasa untuk pekerjaan pribadi maupun klien.",
  ],
  ["Copy Codex configuration · TOML", "Salin konfigurasi Codex · TOML"],
  ["Copy Codex authorization · Shell", "Salin otorisasi Codex · Shell"],
  ["Copy Claude Code · Shell", "Salin Claude Code · Shell"],
  [">Copy</button>", ">Salin</button>"],
  ["PRIVACY", "PRIVASI"],
  ["Privacy", "Privasi"],
  [
    "MemPersist is explicit by design: it stores conversation memory when you or your client asks it to, not by automatically intercepting chats.",
    "MemPersist dirancang secara eksplisit: layanan ini menyimpan memori percakapan saat Anda atau klien Anda memintanya, bukan dengan mencegat chat secara otomatis.",
  ],
  ["Data categories", "Kategori data"],
  ["Account data.", "Data akun."],
  [
    "The email address used for passwordless access, an internal account identifier, and the namespaces owned by that account.",
    "Alamat email yang digunakan untuk akses tanpa kata sandi, pengenal akun internal, dan namespace milik akun tersebut.",
  ],
  ["Memory data.", "Data memori."],
  [
    "Conversation titles, messages, tags, revisions, source metadata, exports, and ChatGPT imports that you intentionally store or import.",
    "Judul percakapan, pesan, tag, revisi, metadata sumber, ekspor, dan impor ChatGPT yang sengaja Anda simpan atau impor.",
  ],
  ["Authentication data.", "Data autentikasi."],
  [
    "Hashes of magic links, dashboard sessions, OAuth codes and tokens, plus the grant and PKCE state needed to authenticate a client. Magic links are single-use and valid for 15 minutes; dashboard sessions last 30 days; OAuth access and refresh tokens use provider defaults of one hour and 30 days.",
    "Hash tautan ajaib, sesi dasbor, kode dan token OAuth, serta status grant dan PKCE yang diperlukan untuk mengautentikasi klien. Tautan ajaib hanya dapat digunakan sekali dan berlaku selama 15 menit; sesi dasbor berlaku selama 30 hari; token akses dan refresh OAuth menggunakan default penyedia selama satu jam dan 30 hari.",
  ],
  ["Operational data.", "Data operasional."],
  [
    "Structured event names, request and job identifiers, paths, and error categories. Cloudflare Workers Logs retain these logs for at most seven days under current documented limits; plan and sampling settings control availability. Logs do not contain conversation bodies, search queries, tokens, or authorization headers.",
    "Nama peristiwa terstruktur, pengenal permintaan dan tugas, path, serta kategori kesalahan. Cloudflare Workers Logs menyimpan log ini paling lama tujuh hari berdasarkan batas yang terdokumentasi saat ini; pengaturan paket dan sampling mengendalikan ketersediaannya. Log tidak berisi isi percakapan, kueri pencarian, token, atau header otorisasi.",
  ],
  ["Derived data.", "Data turunan."],
  [
    "D1 catalog records, chunks, full-text rows, and vector embeddings used for retrieval. Derived indexes are retained only while needed for retrieval, remain account-scoped, and may be deleted or rebuilt at any time.",
    "Catatan katalog D1, chunk, baris teks lengkap, dan embedding vektor yang digunakan untuk pengambilan. Indeks turunan hanya dipertahankan selama diperlukan untuk pengambilan, tetap dibatasi pada akun, dan dapat dihapus atau dibangun ulang kapan saja.",
  ],
  ["Purposes", "Tujuan"],
  [
    "MemPersist uses these categories to authenticate clients, reconnect an account, enforce account and namespace isolation, store and retrieve intentional memory, import and export archives, build search indexes, deliver bounded tool responses, protect the service, and investigate operational failures. It does not infer or invent missing memory, and it does not automatically capture full chats.",
    "MemPersist menggunakan kategori ini untuk mengautentikasi klien, menghubungkan kembali akun, menegakkan isolasi akun dan namespace, menyimpan dan mengambil memori yang sengaja dibuat, mengimpor dan mengekspor arsip, membangun indeks pencarian, mengirim respons alat yang dibatasi, melindungi layanan, dan menyelidiki kegagalan operasional. Layanan ini tidak menyimpulkan atau mengarang memori yang hilang, serta tidak menangkap chat lengkap secara otomatis.",
  ],
  ["Processors and recipients", "Pemroses dan penerima"],
  [
    "MemPersist runs on Cloudflare Workers and uses Cloudflare R2 for private canonical objects, D1 for the catalog and operational data, KV for OAuth state and grants, Vectorize and Workers AI for derived semantic search, Queues for import and indexing jobs, and Cloudflare Email Service for magic links. Cloudflare's official Workers OAuth provider handles OAuth protocol operations and stores token and code hashes in private KV.",
    "MemPersist berjalan di Cloudflare Workers dan menggunakan Cloudflare R2 untuk objek kanonis privat, D1 untuk katalog dan data operasional, KV untuk status dan grant OAuth, Vectorize dan Workers AI untuk pencarian semantik turunan, Queues untuk tugas impor dan pengindeksan, serta Cloudflare Email Service untuk tautan ajaib. Penyedia OAuth Workers resmi Cloudflare menangani operasi protokol OAuth dan menyimpan hash token serta kode di KV privat.",
  ],
  [
    "Your connected MCP client receives only the tool results requested through your authenticated connection. Your email is used for access and is not shared with the client. MemPersist does not publish a public storage bucket or anonymous upload endpoint.",
    "Klien MCP yang terhubung hanya menerima hasil alat yang diminta melalui koneksi terautentikasi Anda. Email Anda digunakan untuk akses dan tidak dibagikan kepada klien. MemPersist tidak menerbitkan bucket penyimpanan publik atau endpoint unggahan anonim.",
  ],
  ["Retention", "Retensi"],
  [
    "Canonical conversation revisions and raw imports remain in private storage while the account or namespace retains them. Raw ChatGPT import archives are intentionally retained when conversations are deleted. Derived chunks, full-text rows, and vectors are disposable and may be deleted and rebuilt. A conversation deletion is complete only after canonical R2 keys are deleted and D1 cleanup commits.",
    "Revisi percakapan kanonis dan impor mentah tetap berada di penyimpanan privat selama akun atau namespace menyimpannya. Arsip impor ChatGPT mentah sengaja dipertahankan ketika percakapan dihapus. Chunk turunan, baris teks lengkap, dan vektor bersifat sekali pakai serta dapat dihapus dan dibangun ulang. Penghapusan percakapan selesai hanya setelah kunci R2 kanonis dihapus dan pembersihan D1 dikomit.",
  ],
  [
    "Scheduling account deletion starts a seven-day grace period. During that period, reads, export, logout, and cancellation remain available, while writes return <code>DELETION_PENDING</code>. Account deletion revokes grants and erases the account data when the deletion job completes.",
    "Penjadwalan penghapusan akun memulai masa tenggang tujuh hari. Selama periode itu, pembacaan, ekspor, logout, dan pembatalan tetap tersedia, sementara penulisan mengembalikan <code>DELETION_PENDING</code>. Penghapusan akun mencabut grant dan menghapus data akun ketika tugas penghapusan selesai.",
  ],
  [
    'Use the authenticated MCP tools or dashboard to search, retrieve, export, update, or delete your own data. Disconnect a client or revoke its OAuth grants when you no longer trust it. Delete conversations only after explicit confirmation; emptying a namespace requires its exact confirmation pair. Schedule account deletion from the dashboard and cancel it during the grace period. Report security issues privately through <a href="https://github.com/ravhirizaldi/mempersist/security/advisories/new">GitHub Security Advisories</a>.',
    'Gunakan alat MCP terautentikasi atau dasbor untuk mencari, mengambil, mengekspor, memperbarui, atau menghapus data milik Anda. Putuskan koneksi klien atau cabut grant OAuth-nya ketika Anda tidak lagi memercayainya. Hapus percakapan hanya setelah konfirmasi eksplisit; pengosongan namespace memerlukan pasangan konfirmasi yang persis. Jadwalkan penghapusan akun dari dasbor dan batalkan selama masa tenggang. Laporkan masalah keamanan secara privat melalui <a href="https://github.com/ravhirizaldi/mempersist/security/advisories/new">GitHub Security Advisories</a>.',
  ],
  ["Contact", "Kontak"],
  [
    'For privacy questions or account support, open an issue at <a href="https://github.com/ravhirizaldi/mempersist/issues">github.com/ravhirizaldi/mempersist/issues</a>. Do not include conversation content, tokens, credentials, or raw logs.',
    'Untuk pertanyaan privasi atau dukungan akun, buka issue di <a href="https://github.com/ravhirizaldi/mempersist/issues">github.com/ravhirizaldi/mempersist/issues</a>. Jangan sertakan isi percakapan, token, kredensial, atau log mentah.',
  ],
  ["TERMS", "KETENTUAN"],
  ["Terms", "Ketentuan"],
  [
    "These terms describe the current MemPersist service behavior for public pages, the dashboard, and the authenticated remote MCP endpoint.",
    "Ketentuan ini menjelaskan perilaku layanan MemPersist saat ini untuk halaman publik, dasbor, dan endpoint MCP jarak jauh terautentikasi.",
  ],
  ["Service scope", "Cakupan layanan"],
  [
    "MemPersist provides a remote Streamable HTTP MCP server for searching, retrieving, compiling, importing, exporting, and intentionally writing conversation memory. The primary endpoint is <code>",
    "MemPersist menyediakan server MCP Streamable HTTP jarak jauh untuk mencari, mengambil, menyusun, mengimpor, mengekspor, dan menulis memori percakapan secara sengaja. Endpoint utama adalah <code>",
  ],
  [
    "</code>. OAuth 2.1 with PKCE and passwordless email links authenticate interactive clients; developer clients may use the owner API token. The single V1 scope is <code>memory</code>.",
    "</code>. OAuth 2.1 dengan PKCE dan tautan email tanpa kata sandi mengautentikasi klien interaktif; klien pengembang dapat menggunakan token API pemilik. Cakupan V1 tunggal adalah <code>memory</code>.",
  ],
  ["Account responsibility", "Tanggung jawab akun"],
  [
    "Keep control of the email inbox used for your archive, connected clients, OAuth grants, and any developer token. Possession of the connected inbox can reconnect to its archive. Use only content and namespaces that you are authorized to store, import, retrieve, or delete. Every request is scoped to the authenticated account; a client cannot select another account's namespace or conversation.",
    "Jaga kendali atas kotak masuk email yang digunakan untuk arsip Anda, klien yang terhubung, grant OAuth, dan token pengembang apa pun. Kepemilikan kotak masuk yang terhubung dapat menghubungkan kembali ke arsipnya. Gunakan hanya konten dan namespace yang Anda berwenang untuk simpan, impor, ambil, atau hapus. Setiap permintaan dibatasi pada akun terautentikasi; klien tidak dapat memilih namespace atau percakapan akun lain.",
  ],
  ["Acceptable use", "Penggunaan yang dapat diterima"],
  [
    "Use MemPersist for your own authorized memory workflows. Do not access another person's archive, use leaked credentials, bypass authentication or ownership checks, submit malicious or oversized imports, extract secrets, degrade the service, or destroy data without the required confirmation. Do not put <code>MEMORY_API_TOKEN</code> into a connector or app configuration; it is for developer API and CLI use.",
    "Gunakan MemPersist untuk alur kerja memori resmi Anda sendiri. Jangan mengakses arsip orang lain, menggunakan kredensial yang bocor, melewati pemeriksaan autentikasi atau kepemilikan, mengirim impor berbahaya atau terlalu besar, mengekstrak rahasia, menurunkan kinerja layanan, atau menghancurkan data tanpa konfirmasi yang diwajibkan. Jangan memasukkan <code>MEMORY_API_TOKEN</code> ke konfigurasi konektor atau aplikasi; token tersebut hanya untuk API pengembang dan CLI.",
  ],
  ["Writes and deletions", "Penulisan dan penghapusan"],
  [
    "Memory enters through explicit MCP writes or an explicit ChatGPT export import; MemPersist does not automatically intercept full chats. Follow the intended <strong>search → select → get context</strong> pattern and verify source and revision identifiers before continuing. Canonical writes are durable before indexing is queued, and a new revision preserves immutable history. Use the complete transcript with <code>memory_replace</code> when replacing, an explicit base revision for revision-safe mutations, and the returned receipts to verify results.",
    "Memori masuk melalui penulisan MCP eksplisit atau impor ekspor ChatGPT eksplisit; MemPersist tidak mencegat chat lengkap secara otomatis. Ikuti pola <strong>search → select → get context</strong> yang dimaksudkan dan verifikasi pengenal sumber serta revisi sebelum melanjutkan. Penulisan kanonis bersifat tahan lama sebelum pengindeksan dimasukkan ke antrean, dan revisi baru mempertahankan riwayat yang tidak dapat diubah. Gunakan transkrip lengkap dengan <code>memory_replace</code> saat mengganti, revisi dasar eksplisit untuk mutasi yang aman terhadap revisi, dan tanda terima yang dikembalikan untuk memverifikasi hasil.",
  ],
  [
    "Destructive tools operate only on your owned conversations or namespaces. <code>memory_delete_conversations</code> deletes selected memories, while <code>memory_empty_namespace</code> requires an exact namespace confirmation and runs in bounded batches. Account deletion has a seven-day grace period; pending account deletion blocks writes while reads, export, logout, and cancellation remain available.",
    "Alat destruktif hanya beroperasi pada percakapan atau namespace milik Anda. <code>memory_delete_conversations</code> menghapus memori yang dipilih, sedangkan <code>memory_empty_namespace</code> memerlukan konfirmasi namespace yang persis dan berjalan dalam batch terbatas. Penghapusan akun memiliki masa tenggang tujuh hari; penghapusan akun yang tertunda memblokir penulisan, sementara pembacaan, ekspor, logout, dan pembatalan tetap tersedia.",
  ],
  ["Availability and limitations", "Ketersediaan dan batasan"],
  [
    "MemPersist provides no promise of uninterrupted availability or continuously current derived indexes. Imports and indexing run through queued, retryable work; search may report <code>degraded</code> or <code>unavailable</code> channels. A canonical write can remain durable when indexing or verification fails. Cloudflare platform services and third-party MCP clients are outside the application's security document, and client behavior can affect your connection.",
    "MemPersist tidak menjanjikan ketersediaan tanpa gangguan atau indeks turunan yang terus diperbarui. Impor dan pengindeksan berjalan melalui pekerjaan yang diantrekan dan dapat dicoba ulang; pencarian dapat melaporkan kanal <code>degraded</code> atau <code>unavailable</code>. Penulisan kanonis dapat tetap tahan lama ketika pengindeksan atau verifikasi gagal. Layanan platform Cloudflare dan klien MCP pihak ketiga berada di luar dokumen keamanan aplikasi, dan perilaku klien dapat memengaruhi koneksi Anda.",
  ],
  [
    'For service questions or account support, open an issue at <a href="https://github.com/ravhirizaldi/mempersist/issues">github.com/ravhirizaldi/mempersist/issues</a>. Report vulnerabilities through <a href="https://github.com/ravhirizaldi/mempersist/security/advisories/new">GitHub Security Advisories</a>, without including real conversation content, tokens, credentials, or raw logs.',
    'Untuk pertanyaan layanan atau dukungan akun, buka issue di <a href="https://github.com/ravhirizaldi/mempersist/issues">github.com/ravhirizaldi/mempersist/issues</a>. Laporkan kerentanan melalui <a href="https://github.com/ravhirizaldi/mempersist/security/advisories/new">GitHub Security Advisories</a>, tanpa menyertakan konten percakapan nyata, token, kredensial, atau log mentah.',
  ],
];

export function localizePageMarkup(locale: Locale, html: string): string {
  if (locale === "en") return html;
  return replacements
    .toSorted(([left], [right]) => right.length - left.length)
    .reduce((localized, [source, translation]) => localized.replaceAll(source, translation), html);
}
