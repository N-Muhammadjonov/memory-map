# Xotira 3D muhandislik hisoboti

## v15

3D grafdagi saqlangan qo‘lda koordinatalar avtomatik tartibdan ajratildi. Filtrlar va to‘liq ombor ko‘rinishlari bir xil mavzu tasnifini ishlatadi. Mind map muharriri mavjud shifrlangan biriktirma modeliga qo‘shildi. Import, raqobatchilar tahlili va qabul mezonlari [Mind map tadqiqoti](MIND_MAP_RESEARCH.md) ichida.

## v14

v14 mavjud ombor, muharrir, graf va API ustida ishlab chiqildi. Yangilanishning asosiy ta’siri xususiyat saqlanishi, talqinni tiklash va omborni ko‘chirishda.

| O‘zgarish | Asl sabab | Fayl va asosiy amal | Tekshiruv va chegarasi |
|---|---|---|---|
| Shifrlangan xususiyat va tiplangan aloqalar | v13 qiymatlari brauzer originiga yozilgan | `vault.py` `unlock`, `update_entity`, `migrate_legacy_entities`, `entity_fields.py`, `web/database-view.js` | v13 sxema, xato bo‘lgandagi qaytarish, saqlangan qiymatlar va shikastlangan ciphertext testlari o‘tdi. Eski port/profil uchun migratsiya qo‘llanmasi kerak |
| Talqin va tiklash | Yangilanish eski ciphertextni almashtirgan | `Vault._store`, `history`, `restore_history`, `web/app.js` `loadHistory` | Matn va xususiyat tuzatishi, stale revision, ko‘chma tiklash testlari. Binar talqinlar yo‘q |
| Ombor qidiruvi | Har agent qidiruvi matnni qayta tokenlagan, sarlavha qidiruvi esa matnni ko‘rmagan | `agent_api.py` `search_index`, `search_brain`, `build_context_pack` | BM25, alias va grafiga ulanadigan kontekst, manba IDlari va indeks invalidatsiyasi. Model javobi va semantik embedding yo‘q |
| Grafik va vazifalar | Canvas hamma tugunni chizgan, joylashuv UIga qayta kelmagan, vazifa 80 qaydgacha cheklangan | `web/graph.js` `graphSample`, `findPath`, `setMode`, `web/app.js` `renderGraph`, `Vault.tasks`, `toggle_task` | Grafik CPU va yo‘l testi, task revision va qator oxiri testi. Real ekrandagi FPS, GPU va assistiv texnologiya sinovi qolgan |
| Tashqi ZIP va ko‘chma tiklash | Mavjud import papka uchun edi, eksportda to‘liq qayta tiklash manifesti yo‘q edi | `archive_import.py`, `import_frontmatter.py`, `portable_archive.py`, `app.py` `add_markdown` va API | Obsidian/Notion namunasi, buzilgan yo‘l rad etilishi, shifrlangan ZIPdan yangi omborga tiklash. Notion CSV asl fayli va soddalashtirilgan YAML qatorlari saqlanadi. Notion formulalari va munosabatlari qayta qurilmaydi |
| Agent takliflari | Agent kaliti to‘g‘ridan-to‘g‘ri yozgan va MCP ko‘prigi arxivda mavjud bo‘lmagan modulni import qilgan | `brain_sdk.py`, `brain_bridge.py`, `app.py` `propose_agent_write`, `web/app.js` `refreshAgentProposals` | Egasi tasdig‘i, eskirish, autentifikatsiya va o‘qish rejimi testlari. Agent kalitidan yozish 202 javob beradi. Takliflar RAMda saqlanadi |

Dastlabki mahsulot hujjati bir necha reliz bosqichini tavsiflaydi. Joriy ZIP ishlaydigan mahalliy yangilanishni va kelgusi ish qamrovini beradi. Qurilmalararo sync, on-device semantic model, real vaqtda hamkorlik va enterprise imkoniyatlari keyingi bosqichlarda.

Mac Safari, mobil va planshetda interaktiv vizual test o‘tkazilmadi. Test muhiti Chromium jarayonini ishga tushirish uchun zarur mahalliy soketni chekladi. Masofaviy brauzer mahalliy serverga ulana olmadi. Server oqimlari HTTP orqali, frontend DOM shartlari va graf hisoblari Node.js orqali tekshirildi. Tafsilotlar [test hisobotida](TEST_RESULTS.md).
