# Keep Coding — Türkçe

Keep Coding, uzun süren coding-agent çalışmalarını kalıcı proje hafızası ve gerçek doğrulama kapılarıyla yöneten tek-akışlı bir platformdur. Kullanıcıya mod seçtirmez; kullanılmayan yeni özellikler mevcut v0.1 davranışına geri düşer.

## Sağlanan yetenekler

- Çalışma başladıktan sonra kanıtları silmeden sürümlü plan değişikliği
- Her başarılı faz için atomik Git commit ve kapsamlı baseline geri alma
- Bağımsız fazların izole Git worktree'lerde paralel yürütülmesi
- Parser/AST tabanlı semantic graph, etki alanı analizi ve etkilenen test seçimi
- Önceden tamamlanan fazların değişiklik etkisine göre tekrar doğrulanması
- Zorunlu secret scan ve token, maliyet, zaman bütçeleri
- Deterministik ana doğrulama ve isteğe bağlı bağımsız critic
- İnsan onayı gereken kararlar için gerçek bekleme durumu
- Açıkça etkinleştirilen projeler arası playbook hafızası
- Yalnızca loopback üzerinde çalışan salt-okunur dashboard
- Codex, Claude-benzeri hook ve generic polling adapter'ları
- CI ve kalıcı kararlardan üretilen PR açıklaması

## Geliştirme

```bash
npm ci
npm run check
```

## Temel kural

Bir faz; dosya kapsamı, secret taraması, bütçe, seçilmiş testler, acceptance komutları ve yapılandırılmış critic kapıları geçmeden `COMPLETED` olmaz. Proje tamamlanırken yapılandırılmış full test suite tekrar çalışır. Plan değişiklikleri yalnızca `amend_plan` ile yapılır ve event geçmişine yazılır.

Temel MCP sırası:

1. `initialize_project`
2. `save_plan`
3. `start_phase`
4. kapsam içi uygulama ve karar kaydı
5. `checkpoint_phase`
6. gerekiyorsa `amend_plan`, `resolve_approval` veya tekrar doğrulama
7. tüm fazlar geçince `complete_project`

Paralel fazlar yalnızca `parallelSafe` olarak işaretlenmiş, kapsam kökleri bağımsız ve aynı anda `READY` olan fazlar için `prepare_parallel_phases` ile açılır.

Dashboard:

```bash
keep-coding dashboard /proje/yolu
```

Varsayılan adres yalnızca `127.0.0.1` üzerindedir. Normal ChatGPT için bounded HTTP MCP kurulumu [CHATGPT_APP.md](CHATGPT_APP.md), mimari ayrıntılar [ARCHITECTURE.md](ARCHITECTURE.md) dosyasındadır.
