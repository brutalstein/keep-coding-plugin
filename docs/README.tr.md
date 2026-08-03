# Keep Coding — Türkçe

Keep Coding, büyük bir yazılım projesi isteğini kalıcı ve kanıt kapılı bir geliştirme akışına dönüştürür. 0.2 sürümünde de kullanıcıya mod seçtirilmez; tek varsayılan akış korunur. Gelişmiş özellikler yalnızca gerektiğinde devreye girer.

Desteklenen yüzeyler:

- **Codex plugini:** skill, lifecycle hook'ları, yerel stdio MCP server ve otomatik context geri yükleme.
- **Normal ChatGPT uygulaması:** uzaktan erişilen MCP endpoint'i ve sınırlandırılmış repo okuma/arama/diff/patch araçları.
- **Diğer coding agent'ları:** Claude Code tarzı hook adaptörü ve generic polling CLI.

Tüm yüzeyler hedef repodaki `.keep-coding/state.db` dosyasını kullanır. Proje sözleşmesi, plan sürümleri, fazlar, kararlar, hatalar, onaylar, checkpoint kanıtları ve semantik etki grafiği aynı kaynaktan okunur.

## Kurulum

```bash
npm ci
npm run check
```

Codex CLI içinde `/plugins` ekranını aç, bu GitHub reposunu marketplace olarak ekle, **Keep Coding** pluginini kur, hook'ları inceleyip güven ver ve yeni bir oturum başlat.

## Normal ChatGPT sohbetinde kullanım

ChatGPT yerel stdio MCP server'a doğrudan bağlanamaz. Server'ı güvenli biçimde uzaktan erişilebilir hâle getirmek gerekir.

```bash
export KEEP_CODING_ALLOWED_ROOTS="/home/me/projects"
export KEEP_CODING_ALLOWED_COMMANDS_JSON='["npm run check","npm test","git diff --check"]'
node plugins/keep-coding/dist/keep-coding.mjs mcp-http
```

Önemli sınırlar:

- Normal ChatGPT yüzeyinde Codex lifecycle hook'ları çalışmaz; uygulamayı sohbette seçmen veya açıkça çağırman gerekir.
- `apply_patch` yalnızca `IN_PROGRESS` fazında ve fazın `allowedScope` alanı içinde çalışır.
- Server yalnızca `KEEP_CODING_ALLOWED_ROOTS` altındaki canonical Git repo yollarını açar.
- Faz test komutları yalnızca operatörün `KEEP_CODING_ALLOWED_COMMANDS_JSON` içinde birebir izin verdiği komutlar olabilir.
- Genel amaçlı uzak shell aracı yoktur.

Ayrıntılı kurulum ve güvenlik açıklaması: [CHATGPT_APP.md](CHATGPT_APP.md).

## Varsayılan akış

1. `initialize_project` ile repo indeksini ve kalıcı ledger'ı oluştur.
2. `save_plan` ile ölçülebilir sözleşmeyi ve acyclic faz DAG'ını kaydet.
3. Çalışma başladıktan sonra gereksinim değişirse `amend_plan` kullan; tamamlanmış checkpoint'leri silme veya yeniden yazma.
4. `get_context` ve `get_impact` ile mevcut durumu ve değişikliğin blast radius'unu incele.
5. `start_phase` ile hazır fazı başlat. Faz onay gerektiriyorsa durum `AWAITING_APPROVAL` olur.
6. Bağımsız iki veya daha fazla faz varsa `prepare_parallel_phases` ile izole Git worktree'leri hazırla.
7. Kararları `record_decision`, başarısız yaklaşımları `record_failure` ile kalıcılaştır.
8. `checkpoint_phase` çağrısında scope, secret scan, bütçe, etkilenen testler, acceptance komutları ve varsa critic sonucu kontrol edilir.
9. Başarısız fazı düzelt veya `restore_phase` ile yalnızca o fazın scope'unu başlangıç hâline döndür.
10. Önceki checkpoint kanıtı etkilenirse ilgili faz `NEEDS_REVERIFICATION` olur.
11. Tüm aktif fazlar tamamlandıktan sonra `complete_project` full-suite kontrolünü çalıştırır.

## 0.2 özellikleri

- Sürümlü ve audit edilebilir adaptive plan değişiklikleri
- Geçen her faz için Git commit'i ve scoped rollback
- Bağımsız fazlar için izole worktree koordinasyonu
- TypeScript/JavaScript AST tabanlı import, symbol, call, reference ve test grafiği
- Impact-aware yeniden doğrulama
- Her checkpoint'te zorunlu secret taraması
- Proje/faz token, maliyet ve süre bütçeleri
- Deterministic gate + opsiyonel advisory/blocking critic
- İnsan onay kapısı
- Impact-driven selective test çalıştırma
- Opt-in cross-project playbook memory
- Loopback-only, read-only dashboard
- Codex, Claude Code tarzı hook ve generic polling adaptörleri
- CI ve durable kayıtlardan PR açıklaması üretimi

## Opsiyonel ayarlar

```bash
# Projeler arası faz şablonu ve hata fingerprint hafızası
export KEEP_CODING_PLAYBOOK=1

# Bağımsız critic süreci; JSON argv kullanılır
export KEEP_CODING_CRITIC_COMMAND_JSON='["node","./critic.mjs"]'

# Dashboard portu; verilmezse boş bir port seçilir
export KEEP_CODING_DASHBOARD_PORT=4317
```

Critic varsayılan olarak advisory'dir. Bloklayıcı olması için sözleşmede `criticGate: "blocking"` açıkça belirtilmelidir.

## Yerel dashboard ve diğer runtime'lar

```bash
keep-coding dashboard /repo/yolu
keep-coding poll /repo/yolu
keep-coding pr-description /repo/yolu
```

Dashboard yalnızca `127.0.0.1`, `::1` veya `localhost` üzerinde açılır ve yazma endpoint'i sunmaz.

## Başarıyı ölçmek

`examples/keep-coding.eval.example.json` dosyasını kopyala; baseline ve Keep Coding koşularında model, prompt, commit, izinler ve verifier komutlarını eşit tut. Ardından:

```bash
node plugins/keep-coding/dist/keep-coding.mjs eval ./keep-coding.eval.json
```

Araç başarı oranlarını, Wilson %95 güven aralıklarını, eşlenmiş farkı ve exact McNemar p-değerini üretir.

Mimari ayrıntılar için [ARCHITECTURE.md](ARCHITECTURE.md), güvenlik sınırları için [../SECURITY.md](../SECURITY.md) dosyasına bak.
