# Dastlabki manba auditi

Asl v13 ZIP SHA-256 qiymati `e86ef2576c4d177b601d5ad1047ce44155b7fd8689de0376ebc8d75bd97d7458`. Arxivda 221 fayl bor edi. Versiyalar nazorati metama’lumotlari va faol ombor arxivga kirmagan. Manba fayllari alohida nusxadan tahrirlandi, asl arxiv va boshlang‘ich fayl xeshlari ish davomida taqqoslash uchun saqlandi. Quyidagi satrlar v13 nusxasiga tegishli.

| Qobiliyat | Mavjud | Qisman | Yetishmagan qism | Dalil | Ustuvorlik |
|---|---|---|---|---|---|
| Mahalliy HTTP va sessiya | Loopback, Host, Origin va Bearer tekshiruvi | Token jarayonga bog‘liq | Ko‘p foydalanuvchili autentifikatsiya | `app.py:136 Server`, `app.py:214 check_request` | P0 |
| Shifrlangan SQLite ombor | Argon2id, AES-GCM, SQLite tranzaksiyalar | Parol ochiq seansdagi xotirada ishlatiladi | Kalit rotatsiyasi va jihozga bog‘langan seanslar | `vault.py:31 SCHEMA`, `vault.py:86 vault_cipher`, `vault.py:196 connection`, `vault.py:241 unlock` | P0 |
| Fayllar va biriktirmalar | Shifrlangan fayl nomi va baytlari, Canvas va chizma | Ofis hujjatlari uchun cheklangan oldindan ko‘rish | PDF izohlarini qayd bilan bog‘lash | `vault.py:592 store_attachment`, `vault.py:609 _store_file`, `document_preview.py:89 preview_office`, `web/viewer.js:44 FileViewer` | P0/P1 |
| Zaxira va tiklash | SQLite snapshot, `quick_check`, `--vault` | Markdown ZIP faol kontentga qaratilgan | To‘liq ko‘chma arxivdagi tiklash yo‘li | `vault.py:793 backup`, `app.py:77 add_markdown`, `app.py:152 service_actions` | P0 |
| Qayd va havolalar | Yuklanadigan Markdown, teg, alias, backlink va bo‘limga havola | Import qilingan frontmatter xom matnda | Keng qamrovli blok identifikatori va strukturali bog‘lanishlar | `vault_links.py:96 resolve`, `vault.py:428 get_note`, `web/markdown.js:140 renderMarkdown` | P0 |
| Tahrirlash va navigatsiya | Rich editor, manba rejimi, tablar, orqaga/oldinga | Autosave versiya to‘qnashuvini bildiradi | Tarix ko‘rish va tiklash | `web/notion-editor.js:489 NotionEditor`, `web/app.js:848 saveDraft`, `web/app.js:886 openNote` | P0 |
| Baza va vazifalar | Jadval, Kanban, galereya, markdowndagi vazifalar | Holat va muddat brauzerga bog‘liq; 80 qayd chegarasi | Ombordagi bitta kanonik xususiyat modeli | `web/database-view.js:26 loadAllNoteMeta`, `web/database-view.js:36 setNoteMeta`, `web/app.js:767 loadAllVaultTasks` | P0 |
| 3D xarita | Canvas 2D proyeksiyasi, fizika, klaster, mahalliy xarita, yo‘l | Saqlangan pozitsiya UIga qayta berilmagan | To‘liq grafikda yuk cheklovi va ro‘yxat muqobili | `web/graph.js:154 NoteGraph`, `web/graph.js:243 setData`, `web/app.js:366 renderGraph`, `vault.py:399 graph_positions` | P0 |
| Agent API va qidiruv | Tokenli REST, leksik ball, bir pog‘ona kontekst | Yozuv bir yo‘la bajarilgan; MCP SDK arxivdagi fayllarda yo‘q | Taklif va egasi tasdig‘i, embedding, dalil chegaralari | `agent_api.py:74 search_brain`, `agent_api.py:199 build_context_pack`, `app.py:459 handle_agent_api`, `brain_bridge.py:10` | P0 |
| Import | Papka protokoli, qaydlar, asl fayl va tuzilma | Bitta import tranzaksiyasi; brauzer papka tanlovi maxsus | ZIP va Notion eksportlarini o‘qish | `web/folder.js:4 folderPacket`, `folder_import.py:29 read_import`, `vault.py:620 import_folder` | P0 |
| Fokus va o‘qish | Shablonlar, kundalik qayd, flashcard va fokus taymeri | Sessiya doirasidagi amallar | Uzoq muddatli repetition modeli | `web/study-mode.js:20 extractCardsFromMarkdown`, `web/study-mode.js:74 StudyMode`, `web/app.js:925 openDailyNote` | P1 |
| Sinxronlash, hamkorlik, plagin | Mahalliy agent API | Mahalliy foydalanish | Qurilmalararo replikatsiya, rollar, CRDT, SDK va marketplace | `app.py:136 Server`, `app.py:520 main`, `vault.py:196 connection` | P0–P2 |

So‘rov oqimi `Handler.handle_request` ichida statik fayl yoki APIga yo‘naltiriladi. API JSON va yuklash chegarasini tekshiradi, so‘ng serverning mutexi ostida omborga kiradi. Xatolar JSON statuslari yoki umumiy disk xatosi bilan qaytariladi. Avtomatik zaxira har o‘zgarish uchun darhol yozilmaydi va faqat `--backup-dir` berilganida faol.

`web/app.js` ish maydonining holati, qidiruv, navigatsiya, autosave va fayl ko‘rinishini boshqaradi. `database-view.js`, `graph.js`, `notion-editor.js`, `viewer.js` va `canvas-board.js` ES modullar. `sessionStorage` mahalliy seans tokenini, `localStorage` mavzu va v13 holatlarini saqlagan. Tahrirlash uchun klaviatura yo‘li mavjud, lekin UI qamroviga haqiqiy ekrandagi testlar kerak.

Boshlang‘ich to‘qqizta test ombor hayot sikli, fayl va chizma, papka importi, agent amallari, havolalar va zaxirani qamradi. Frontend uchun ishga tushiriladigan test yoki grafik benchmark arxivda yo‘q edi.
