# Keep Coding — Türkçe

Keep Coding, uzun süreli coding-agent çalışmalarını kalıcı sözleşme, bağımlılık DAG'ı, kapsamlı uygulama, kanıtlı checkpoint ve full-suite completion gate üzerinden yöneten local-first bir control plane'dir. Eski v0.1-v0.3 SQLite state dosyaları additive migration ile açılır.

## Durum

**Güncel sürüm: v0.4.0.** Bu sürüm Python ve C/C++ graph extraction katmanını gerçek syntax tree seviyesine çıkarır; branch coverage için zorunlu `%75` tabanı getirir; tekrar üretilebilir paired evaluation corpus'u, host-agnostic MCP/Agent Skills dağıtımı ve davranış değiştirmeyen storage decomposition ekler.

## Temel garantiler

- Faz; scope, secret, bütçe, selective test, acceptance command, approval, correction radius ve critic kapıları geçmeden `COMPLETED` olmaz.
- `complete_project`, bütün aktif ve `REVERIFY_REQUIRED` fazları doğrular ve full suite çalıştırır.
- Plan değişiklikleri versioned ve auditable'dır; tamamlanmış kanıt silinmez.
- Remote patch'ler canonical root ve aktif faz scope'u dışına çıkamaz.
- CI yalnızca source testini değil production CLI'ı ve parser sidecar dosyalarını da çalıştırır.
- Native parser hatası indexlemeyi düşürmez; açıkça işaretlenen legacy fallback'e geçer.
- Düşük confidence assumption ve yüksek ambiguity checkpoint'i sessizce geçemez.

## Sağlanan yetenekler

- Adaptive plan amendment, Git-native checkpoint, scoped restore ve parallel worktree
- TypeScript compiler AST; Python, C ve C++ için WASM tree-sitter parser
- Python decorator/nested scope; C/C++ namespace/template/function/include analizi
- Header/source sembollerini `same_symbol` edge'iyle birleştirme
- Semantic impact, impacted-test seçimi ve reverification
- Secret scan, token/maliyet/zaman bütçesi, approval ve bağımsız critic
- Delta context, unchanged-hook suppression, Tier-0/Tier-1 graph ve file digest
- Command-output compression, repeated-failure diff ve normalized clustering
- Assumption ledger, bounded correction ve cross-project anti-pattern hafızası
- Codex/Claude hooks, generic MCP ve hookless `poll` adapter'ı
- Bütün host paketlerinde byte-identical canonical Agent Skill
- Detached worktree ve bağımsız verifier kullanan 24 görevlik frozen paired evaluation corpus'u

## Geliştirme

```bash
npm ci
npm run check
```

`npm run check`; lint, strict TypeScript, coverage ve coverage delta raporu, production build, byte-identical dist kontrolü, compiled artifact testleri, context/graph benchmark'ları, WASM asset integrity, evaluator corpus, distribution, doküman ve executable plugin doğrulamasını çalıştırır.

Commitlenen dağıtım yalnızca `keep-coding.mjs` değildir; `plugins/keep-coding/dist/` altındaki executable, hash-manifestli WASM grammar'lar ve query dosyalarının tamamıdır.

Doğrulanmış source suite: 128 test, 31 dosya. Build sonrası artifact suite beş compiled-distribution senaryosu ekler; context ve graph benchmark'ları ayrı çalışır.

## Kullanım ve dağıtım

Generic MCP kurulumu için [INSTALL_MCP.md](INSTALL_MCP.md) kullanılır. Aynı canonical backend Codex plugin, Claude plugin, Agent Skills, stdio/HTTP MCP ve hook sistemi olmayan hostlar için `poll` üzerinden sunulur. Host başına ayrı ürün mantığı fork edilmez.

## Semantic graph sınırı

TypeScript/JavaScript gerçek compiler AST kullanır. Python, C ve C++; pinned sürümlü ve SHA-256 doğrulamalı tree-sitter WASM grammar'ları kullanır. Bu katman doğru local syntax ve lexical scope sağlar; Pyright/clangd seviyesinde cross-module type resolution, macro expansion, conditional preprocessing ve template instantiation sağlamaz. Tier-2 enrichment, gerçek corpus kanıtı oluşmadan spekülatif biçimde etkinleştirilmeyecektir.

## Evaluation dürüstlüğü

Repository 24 görevlik frozen corpus ve paired runner içerir; ancak provider credential veya agent executable olmadan efficacy yüzdesi uydurmaz. Mevcut kanıt durumu ve çalıştırma sözleşmesi [EVALUATION_RESULTS.md](EVALUATION_RESULTS.md) içinde yayınlanır.
