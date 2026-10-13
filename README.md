# 시니어 동네 점검단 (GitHub Pages)

팀 이로움. 앱으로 들어가는 입구 페이지와 예전 시험판을 둔다. 앱 자체(시니어 앱·관리자 웹·업무 API)는 운영 서버에서 서비스한다.

| 주소 | 내용 |
|---|---|
| https://teamiroum.github.io/service/ | 입구: 시니어 앱 / 관리자 웹 버튼 |
| https://teamiroum.github.io/service/senior | 바로 시니어 앱으로 |
| https://teamiroum.github.io/service/admin | 바로 관리자 웹으로 |
| https://teamiroum.github.io/service/test/ | 예전 시험용 PWA (AI 판독 검증 콘솔 연결) |
| https://teamiroum.github.io/service/test/senior/ | 예전 시니어 앱 시험판 |

- 입구 페이지는 [TeamIroum/Contest](https://github.com/TeamIroum/Contest)의 `service/web/pages/deploy_pages.py`로 올린다
- 시험판은 `tools/ai-verify/pwa/deploy_pages.py`, `deploy_senior_pages.py`로 올린다 (`test/` 아래)
- 이 저장소의 예전 이름은 `pwa-test`였다. 예전 주소 `teamiroum.github.io/pwa-test/…`는 더 이상 열리지 않는다
