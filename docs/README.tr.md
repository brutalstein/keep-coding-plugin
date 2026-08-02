# Keep Coding — Türkçe

Keep Coding, tek bir büyük proje promptunu kalıcı ve doğrulama kapılı bir geliştirme akışına dönüştüren Codex pluginidir. V1'de mod seçimi yoktur; tek varsayılan akış otomatik çalışır.

Plugin şu parçaları birlikte sunar:

- Codex'in nasıl ilerleyeceğini belirleyen skill,
- büyük proje isteğini algılayan ve context sıkıştırmalarından sonra durumu geri yükleyen hook'lar,
- fazları ve kontrol noktalarını yöneten yerel MCP server,
- proje sözleşmesini, kararları, hataları ve codebase graph'ını tutan SQLite hafıza,
- aynı promptu pluginsiz ve Keep Coding ile eşlenmiş biçimde deneyen A/B test aracı.

## Nasıl çalışır?

Codex önce ölçülebilir bir proje sözleşmesi ve bağımlılıkları olan fazlar üretir. Aynı anda yalnızca hazır bir faz çalışır. Fazın değiştirebileceği dosyalar glob kurallarıyla sınırlıdır. Faz sonunda gerçek test/lint/build komutları çalışmadan sonraki faz açılmaz. Başarısız yöntemler kaydedilir; context sıkışsa veya yeni oturum açılsa bile aktif sözleşme ve faz yeniden yüklenir.

## Kurulum

Geliştirme için:

```bash
npm ci
npm run check
```

Codex CLI içinde `/plugins` ekranını aç, bu GitHub reposunu marketplace olarak ekle, **Keep Coding** pluginini kur, hook'ları inceleyip güven ver ve yeni bir oturum başlat. Güncel yüzey ve kurulum bilgisi için [resmî Codex plugin dokümanına](https://developers.openai.com/codex/plugins) bak.

## Kullanım

Kurulumdan sonra hedef Git reposunda istediğin ürünü tek promptta tarif et. Örnek:

> Bu projeyi production-ready olarak uçtan uca geliştir; mimariyi, implementasyonu, testleri, dokümantasyonu ve release ayarlarını tamamla.

İstek proje ölçeğine ulaştığında Keep Coding otomatik devreye girer. V1'de hız/strict/manuel gibi farklı modlar yoktur.

Hafıza hedef repoda `.keep-coding/state.db` içinde tutulur. Hedef projenin `.gitignore` dosyasına `.keep-coding/` eklemen önerilir.

## Başarıyı ölçmek

`examples/keep-coding.eval.example.json` dosyasını kopyala. Baseline ve Keep Coding komutlarında model, prompt, commit, izinler ve doğrulama komutlarını eşit tut; yalnızca plugin kullanılabilirliğini değiştir. Ardından:

```bash
node plugins/keep-coding/dist/keep-coding.mjs eval ./keep-coding.eval.json
```

Araç başarı oranlarını, Wilson %95 güven aralıklarını, eşlenmiş farkı ve exact McNemar p-değerini üretir. Bu repo ölçüm altyapısını doğrular; gerçek model başarısı iddiası için kendi görev setinde yeterli sayıda koşu yapmalısın.

