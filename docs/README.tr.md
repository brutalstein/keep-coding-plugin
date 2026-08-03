# Keep Coding — Türkçe

Keep Coding, büyük bir proje promptunu kalıcı ve doğrulama kapılı bir geliştirme akışına dönüştürür. V1 ürün yaklaşımında mod seçimi yoktur; tek varsayılan akış kullanılır.

İki yüzeyi destekler:

- **Codex plugini:** skill, lifecycle hook'ları, yerel stdio MCP server ve context geri yükleme.
- **Normal ChatGPT uygulaması:** uzaktan erişilen MCP endpoint'i ve sınırlandırılmış repo okuma/arama/diff/patch araçları.

İki yüzey de proje sözleşmesini, fazları, kararları, hataları, checkpoint kanıtlarını ve codebase graph'ını hedef repodaki `.keep-coding/state.db` içinde paylaşır.

## Codex kurulumu

```bash
npm ci
npm run check
```

Codex CLI içinde `/plugins` ekranını aç, bu GitHub reposunu marketplace olarak ekle, **Keep Coding** pluginini kur, hook'ları inceleyip güven ver ve yeni bir oturum başlat.

## Normal ChatGPT sohbetinde kullanım

ChatGPT yerel stdio MCP server'a doğrudan bağlanamaz. Server'ı uzaktan erişilebilir hâle getirmek gerekir; geliştirici bilgisayarı veya özel ağ için OpenAI Secure MCP Tunnel tercih edilmelidir.

```bash
export KEEP_CODING_ALLOWED_ROOTS="/home/me/projects"
export KEEP_CODING_ALLOWED_COMMANDS_JSON='["npm run check","npm test","git diff --check"]'
node plugins/keep-coding/dist/keep-coding.mjs mcp-http
```

Varsayılan endpoint `http://127.0.0.1:8787/mcp` olur. Ardından uygun ChatGPT çalışma alanında geliştirici modunu açıp bu endpoint'i özel uygulama olarak ekle, araçları tarat ve izinleri incele.

Önemli sınırlar:

- Normal ChatGPT yüzeyinde Codex lifecycle hook'ları çalışmaz; uygulamayı sohbette seçmen veya açıkça çağırman gerekir.
- `apply_patch` yalnızca `IN_PROGRESS` fazında ve fazın `allowedScope` alanı içinde çalışır.
- Server yalnızca `KEEP_CODING_ALLOWED_ROOTS` altındaki canonical Git repo yollarını açar.
- Faz test komutları yalnızca operatörün `KEEP_CODING_ALLOWED_COMMANDS_JSON` içinde birebir izin verdiği komutlar olabilir.
- Genel amaçlı uzak shell aracı yoktur.

3 Ağustos 2026 itibarıyla tam MCP yazma/değiştirme eylemleri ChatGPT Business, Enterprise ve Edu planlarında beta olarak sunulmaktadır. Pro özel MCP uygulamalarını read/fetch izinleriyle bağlayabilir; `apply_patch` gibi yazma araçları için yeterli değildir. Güncel plan ve arayüz durumunu her kurulumdan önce resmî OpenAI dokümanından doğrula.

Ayrıntılı kurulum ve güvenlik açıklaması: [CHATGPT_APP.md](CHATGPT_APP.md).

## Kullanım akışı

1. `initialize_project`
2. `save_plan`
3. hazır faz için `start_phase`
4. repo araçlarıyla inceleme ve `apply_patch`
5. `checkpoint_phase`
6. tüm fazlar geçince `complete_project`

Test/lint/build kanıtı geçmeden faz tamamlanmaz. Başarısız yöntemler kaydedilir ve sonraki denemelerde tekrar edilmemesi için context'e geri yüklenir.

## Başarıyı ölçmek

`examples/keep-coding.eval.example.json` dosyasını kopyala; baseline ve Keep Coding koşularında model, prompt, commit, izinler ve verifier komutlarını eşit tut. Ardından:

```bash
node plugins/keep-coding/dist/keep-coding.mjs eval ./keep-coding.eval.json
```

Araç başarı oranlarını, Wilson %95 güven aralıklarını, eşlenmiş farkı ve exact McNemar p-değerini üretir.
