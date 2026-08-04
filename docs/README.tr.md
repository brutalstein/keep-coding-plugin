# Keep Coding — Türkçe

Keep Coding, uzun süren coding-agent çalışmalarını kalıcı proje hafızası ve gerçek doğrulama kapılarıyla yöneten tek-akışlı bir platformdur. Kullanıcıya mod seçtirmez; eski v0.1/v0.2 state veritabanlarını additive migration ile açar.

## Durum

**Güncel sürüm: v0.3.0.** Bu sürüm, v0.2.1 kanıt ve token-verimliliği platformuna kalıcı assumption ledger ve sınırlı blast-radius correction protokolü ekler. Yanlış yorumlar artık dosya, sembol ve kararlarla ilişkilendirilen kalıcı graph varlıklarıdır; agent yalnızca hesaplanan veya gerekçeli biçimde genişletilen correction kapsamını düzeltebilir.

## Sağlanan yetenekler

- Çalışma başladıktan sonra kanıtları silmeden sürümlü plan değişikliği
- Her başarılı faz için atomik Git commit ve kapsamlı baseline geri alma
- Bağımsız fazların izole Git worktree'lerde paralel yürütülmesi
- TypeScript/JavaScript için compiler AST, diğer diller için bounded adapter'lar, semantic impact ve seçilmiş testler
- Önceden tamamlanan fazların değişiklik etkisine göre tekrar doğrulanması
- Zorunlu secret scan; token, maliyet ve zaman bütçeleri
- Deterministik ana doğrulama ve isteğe bağlı bağımsız critic
- Zayıf acceptance komutları için non-blocking kalite uyarıları
- İnsan onayı gereken kararlar için gerçek bekleme durumu
- Sequence tabanlı delta context ve session başına değişmeyen hook suppression
- Varsayılan Tier-0 graph özeti, gerektiğinde `expand_graph` ile Tier-1 ayrıntı
- Dosyayı tamamen okumadan sembol/import özeti veren `get_file_digest`
- Tekrarlanan failure log diff'i, noise stripping, marker-aware truncation ve failure clustering
- Gerçek veya tahmini token telemetrisi ve %70/%90 bütçe tavsiyeleri
- Compact ve deduplicated projeler arası playbook hafızası
- Dosya, sembol ve kararlara bağlanan kalıcı assumption ledger
- Cycle-safe, hop-limitli correction blast radius ve contained/expanded outcome kaydı
- İngilizce/Türkçe ambiguity pre-flight, düşük confidence için zorunlu blocking critic ve non-blocking apology nudge
- Tekrarlanan yanlış yorumları önceden gösteren correction anti-pattern hafızası
- Yalnızca loopback üzerinde çalışan salt-okunur dashboard
- Codex, Claude-benzeri hook ve generic polling adapter'ları
- CI ve kalıcı kararlardan üretilen PR açıklaması

## Geliştirme

```bash
npm ci
npm run check
```

`npm run check`; lint, strict TypeScript, source coverage, production build, derlenmiş artifact smoke testleri, context payload benchmark'ı, doküman/sürüm kontrolü ve plugin doğrulamasını çalıştırır. Bu nedenle kaynak testleri yeşilken bozuk bir `dist/keep-coding.mjs` paketlenemez.

Doğrulanmış source suite: 107 test, 26 dosya. Build sonrası artifact suite dört compiled-binary senaryo ekler; context benchmark'ı ayrı çalışır.

## Temel kural

Bir faz; dosya kapsamı, secret taraması, bütçe, seçilmiş testler, acceptance komutları ve yapılandırılmış critic kapıları geçmeden `COMPLETED` olmaz. Token verimliliği yalnızca tekrarlı payload'ı azaltır; doğrulama rigor'unu azaltmaz. Proje tamamlanırken yapılandırılmış full test suite tekrar çalışır. Plan değişiklikleri yalnızca `amend_plan` ile yapılır ve event geçmişine yazılır.

Temel MCP sırası:

1. `initialize_project`
2. `save_plan`
3. `start_phase`
4. kapsam içi uygulama ve karar kaydı
5. `checkpoint_phase`
6. gerekiyorsa `amend_plan`, `resolve_approval` veya tekrar doğrulama
7. tüm fazlar geçince `complete_project`

Normal reasoning akışında `get_context` çağrısında `include_snapshot` kullanma. Son sequence değerini `since_sequence` olarak geçir; değişiklik yoksa yalnızca compact `{ "unchanged": true, "sequence": ... }` döner. Orientation için tam dosya okumadan önce `get_file_digest`, kesin bağımlılık düğümleri gerektiğinde `expand_graph` kullan.

Belirsiz bir yorumla uygulamaya başlamadan önce `record_assumption`, ardından ilgili file/symbol/decision düğümleri için `link_assumption` çağrılır. Varsayım doğruysa `confirm_assumption`; yanlışsa `invalidate_assumption` kullanılır. Correction checkpoint yalnızca faz kapsamı ile blast radius kesişimindeki dosyalara izin verir. Daha geniş gerçek kapsam gerekiyorsa `expand_correction_scope` boş olmayan bir gerekçeyle çağrılmalıdır. Varsayılan confidence eşiği `0.6` değeridir.

Evaluation raporu; containment rate ve Wilson %95 aralığını, project-scope tokens-per-correction değerini, anti-pattern hit rate değerini ve isteğe bağlı enabled/disabled McNemar karşılaştırmasını içerir.

Paralel fazlar yalnızca `parallelSafe` olarak işaretlenmiş, kapsam kökleri bağımsız ve aynı anda `READY` olan fazlar için `prepare_parallel_phases` ile açılır.

Dashboard:

```bash
keep-coding dashboard /proje/yolu
```

Varsayılan adres yalnızca `127.0.0.1` üzerindedir. Normal ChatGPT için bounded HTTP MCP kurulumu [CHATGPT_APP.md](CHATGPT_APP.md), mimari ayrıntılar [ARCHITECTURE.md](ARCHITECTURE.md) dosyasındadır.
