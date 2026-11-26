# Yakuniy qamrov

| Talab | Holat | Dalil yoki keyingi qadam |
|---|---|---|
| v13 audit va boshlang‘ich testlar | Tekshirilgan | Audit, ZIP xeshi, 9 test |
| Shifrlangan metama’lumot, qayta bajariladigan migratsiya | Tekshirilgan | `Vault.unlock`, `Vault.migrate_legacy_entities`, xato induksiyasi va qayta yuklash |
| Barqaror obyekt, standart turlar, bog‘lanish | Tekshirilgan | `entity_fields.py`, `Vault.relationships`, `test_relationships_search_and_history` |
| Matn va xususiyatlar tarixi | Tekshirilgan server, UI qisman | `Vault._store`, `history`, `restore_history`, UI DOM shartlari. Binar fayl tarixi ochiq |
| Universal BM25 va grafik kontekst | Tekshirilgan server | `agent_api.search_index`, `build_context_pack`, lokatsiyali manba. Embedding va model javoblari boshlanmagan |
| Obsidian papka va ZIP | Tekshirilgan namunaviy eksport | `import_folder`, `frontmatter_names`, Markdown va alias. Murakkab bloklar, plugin shakli va Obsidian sozlamalari bo‘yicha qamrov cheklangan |
| Notion Markdown/HTML ZIP | Qisman | Soddalashtirilgan HTML Markdown va asl fayllar. 500 qatorgacha CSV xossalari qaydlarda YAMLga o‘tadi. Katta CSV va ichki ZIP asl fayl bo‘lib qoladi. Formula va relation importi ochiq |
| To‘liq ko‘chma eksport va yangi omborga tiklash | Tekshirilgan | `test_portable_roundtrip`, `restore_snapshot` |
| Grafik rejimlari va lokal navigatsiya | Qisman | 3D/2D/qatlam/ro‘yxat va namuna CPU testi. GPU, haqiqiy frame, mobil qurilma, saqlangan perspektiva va to‘liq semantic clustering qamralmagan |
| Vazifa va taqvim | Qisman | Global Markdown vazifa API, kanonik muddat bo‘yicha oylik ro‘yxat. Timeline, formula, form va rolluplar ochiq |
| Agentga ulanish, taklif, egasi tasdig‘i | Tekshirilgan server | `brain_sdk`, `propose_agent_write`, `/api/review-agent`. Tashqi MCP host bilan integratsiya, doimiy audit va inference keyingi ish |
| Shifrlangan ko‘p qurilmali sync, CRDT, native mobil | Boshlanmagan | To‘liq tiklash ZIPi sinxronlash xizmatiga aylanmaydi |
| Jamoa, rollar, plaginlar, integratsiya, enterprise | Boshlanmagan | Keyingi bosqichlar |
| Raqobat va 10 000 validatsiya | Tadqiqot rejasi tayyor | 10 raqobatchi bo‘yicha manbalar va reja. So‘rov o‘tkazilmagan |
