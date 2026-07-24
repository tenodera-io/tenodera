> **ARCHIVED — historical v0.x document (2026-07-23).** Preserved for reference; not maintained. Superseded by the Tenodera v2 rebuild — see `docs/architecture/TENODERA_V2.md`.

---

Głęboka analiza projektu Tenodera

Analizę wykonałem na aktualnym kodzie gałęzi main, odczytanym 23 lipca 2026 r. Projekt jest nadal młody — repozytorium ma wersję v0.2.13, około 371 commitów, a autorzy sami zaznaczają brak zewnętrznego audytu bezpieczeństwa.

Nie udało mi się sklonować repozytorium do lokalnego środowiska z powodu niedostępności DNS w kontenerze. Jest to więc dokładny statyczny code review, ale bez uruchomienia:

cargo test
cargo clippy
cargo audit
cargo deny
npm test
npm audit
npm run build
testów integracyjnych WebSocket/PAM/systemd

Literalne omówienie każdej pustej linii, importu i klamry w całym repozytorium nie zmieściłoby się w jednej odpowiedzi. Poniżej przechodzę jednak przez wszystkie istotne moduły i bloki kodu, wskazując działanie, zależności, błędy i konsekwencje.

1. Wniosek ogólny

Tenodera ma rozsądną i nowoczesną architekturę, szczególnie w zakresie:

rozdzielenia gatewaya, agenta, protokołu i UI;
wykorzystania Rust po stronie uprzywilejowanych komponentów;
stałego połączenia wychodzącego z agentów;
kryptograficznej identyfikacji agentów Ed25519;
systemowego uwierzytelniania użytkowników przez PAM;
ograniczenia gatewaya domyślnie do 127.0.0.1;
terminacji HTTPS przez Caddy;
częściowego wykorzystania type-state i silnych typów.

Jednocześnie w obecnym kodzie znajdują się realne błędy autoryzacji i ochrony sekretów, które wykluczają bezpieczne wystawienie panelu bezpośrednio do Internetu.

Moja ocena:

Obszar	Ocena
Architektura	8/10
Projekt protokołu	7/10
Bezpieczeństwo agent–gateway	7/10
Autoryzacja REST/WebSocket	5/10
Ochrona sekretów	5/10
Frontend	6/10
Instalacja i supply chain	4/10
Dokumentacja	5/10
Gotowość produkcyjna	beta / wymaga hardeningu

Najpoważniejsze problemy to:

nieuwierzytelniony dostęp do /api/hosts;
użytkownik readonly może usuwać i modyfikować hosty;
pełne komunikaty WebSocket, potencjalnie zawierające hasła, trafiają do logów TRACE;
w trybie HTTP hasło sudo jest zapisywane jawnie w sessionStorage;
instalator pobiera i buduje zmienną gałąź main bez weryfikacji checksumy;
wykorzystanie sudo sh -c znacząco rozszerza wymagane uprawnienia agenta.
2. Architektura
2.1. Przepływ komunikacji

W uproszczeniu:

                    HTTPS / WSS
┌────────────┐     ──────────────►     ┌──────────────────────┐
│ Przeglądarka│                         │ Caddy                │
│ React UI    │     ◄──────────────     │ reverse proxy :443   │
└────────────┘                          └──────────┬───────────┘
                                                │ HTTP/WS
                                                │ 127.0.0.1:9090
                                     ┌──────────▼───────────┐
                                     │ Tenodera Gateway     │
                                     │ Rust / Axum          │
                                     │ PAM + sessions       │
                                     │ channel multiplexing │
                                     └──────────┬───────────┘
                                                │
                         persistent outbound WS │ /api/agent
                                                │
                ┌───────────────────────────────┼────────────────────────┐
                │                               │                        │
       ┌────────▼────────┐             ┌────────▼────────┐      ┌────────▼────────┐
       │ tenodera-agent  │             │ tenodera-agent  │      │ tenodera-agent  │
       │ host A / root   │             │ host B / root   │      │ host C / root   │
       └─────────────────┘             └─────────────────┘      └─────────────────┘

Agent nie otwiera portu wejściowego na zarządzanym hoście. Sam inicjuje trwałe połączenie WebSocket do gatewaya. To dobry model dla hostów znajdujących się za NAT-em, firewallem lub bez publicznego adresu. Gateway następnie multipleksuje żądania użytkownika na logiczne kanały do odpowiednich agentów.

Aktualny instalator utrzymuje gateway na 127.0.0.1, a dostęp sieciowy przekazuje przez Caddy i HTTPS. To istotna poprawa względem starszych fragmentów dokumentacji sugerujących szerszy bind lub nieszyfrowane połączenia.

2.2. Podział repozytorium

Najważniejsze katalogi:

tenodera/
├── agent/                 # uprzywilejowany agent systemowy
├── panel/
│   ├── crates/gateway/    # gateway Rust/Axum
│   └── ui/                # React/TypeScript/Vite
├── protocol/              # współdzielony protokół Rust
├── docs/                  # dokumentacja i threat model
├── packaging/             # jednostki systemd i pakiety
├── tenodera.sh            # główny instalator
└── agent.sh               # instalator zdalnego agenta

Frontend wykorzystuje React 19, TypeScript, Vite, React Router, TanStack Query, Recharts i xterm.js. Backend oraz agent są napisane w Rust.

2.3. Granice zaufania

W projekcie istnieją cztery zasadnicze poziomy zaufania:

1. Przeglądarka operatora
2. Gateway
3. Kanał gateway ↔ agent
4. Agent działający na hoście z uprawnieniami root

Najważniejsze jest to, że agent ma możliwość:

uruchamiania poleceń;
zarządzania systemd;
zarządzania pakietami;
modyfikowania plików;
otwierania terminala;
wykonywania operacji przez sudo;
zarządzania użytkownikami i siecią.

Przejęcie gatewaya, sesji administratora albo kanału do agenta ma zatem blast radius porównywalny z przejęciem systemu zarządzania flotą.

3. Najpoważniejsze podatności
HIGH-01: /api/hosts nie wymaga uwierzytelnienia

Router rejestruje endpoint:

.route("/api/hosts", axum::routing::get(hosts_list))

Funkcja hosts_list() otrzymuje AppState i nagłówki, ale:

nie pobiera Authorization;
nie weryfikuje sesji;
nie sprawdza roli;
od razu ładuje konfigurację hostów.
async fn hosts_list(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Json<serde_json::Value> {
    let config = hosts_config::load().await;
    let online = state.agent_registry.online_host_ids().await;
    // ...
}

Zwracane są między innymi:

id
name
hostname
display_name
added_at
last_seen
online
is_local
remote_ip
os_id

Oznacza to, że klient bez sesji może prawdopodobnie pobrać inwentarz infrastruktury, w tym nazwy hostów, identyfikatory, adresy IP, system operacyjny i stan online. Nie ma globalnego middleware wymuszającego uwierzytelnienie — router ma jedynie middleware bezpieczeństwa nagłówków i limit body.

Wpływ
reconnaissance infrastruktury;
ujawnienie nazw wewnętrznych;
identyfikacja aktywnych hostów;
ujawnienie adresacji;
łatwiejsze przygotowanie phishingu lub ataku ukierunkowanego;
ujawnienie identyfikatorów potrzebnych do dalszych żądań.
Poprawka

Endpoint powinien wymagać co najmniej poprawnej sesji:

async fn require_session(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Session, StatusCode> {
    let token = extract_bearer_token(headers)
        .ok_or(StatusCode::UNAUTHORIZED)?;

    state
        .sessions
        .get_valid(&token)
        .await
        .ok_or(StatusCode::UNAUTHORIZED)
}

async fn hosts_list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let _session = require_session(&state, &headers).await?;

    // ...
    Ok(Json(serde_json::json!({ "hosts": hosts })))
}

Dodatkowo pole remote_ip można zwracać wyłącznie administratorowi.

HIGH-02: użytkownik readonly może usuwać hosty

hosts_remove() sprawdza tylko, czy sesja istnieje:

let token = match extract_bearer_token(&headers) {
    Some(t) => t,
    None => return StatusCode::UNAUTHORIZED,
};

if state.sessions.get(&token).await.is_none() {
    return StatusCode::UNAUTHORIZED;
}

Następnie bez sprawdzenia Role::Admin usuwa host z konfiguracji:

config.hosts.retain(|h| h.id != id);
hosts_config::save(&config).await

W tym samym pliku istnieje już funkcja require_admin(), ale nie została tutaj użyta.

Wpływ

Każdy zalogowany użytkownik, nawet readonly, może:

usunąć zapisany host;
spowodować utratę jego przypisania;
wymusić ponowny enrollment;
zakłócić zarządzanie flotą;
potencjalnie wprowadzić host w stan oczekiwania na ponowne zatwierdzenie.

To klasyczny błąd Broken Access Control.

Poprawka
async fn hosts_remove(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> StatusCode {
    if require_admin(&state, &headers).await.is_err() {
        return StatusCode::FORBIDDEN;
    }

    // dalsze usuwanie
}

Lepiej rozróżnić brak sesji od niewłaściwej roli:

match require_session(&state, &headers).await {
    Err(_) => return StatusCode::UNAUTHORIZED,
    Ok(session) if session.role != Role::Admin => {
        return StatusCode::FORBIDDEN;
    }
    Ok(_) => {}
}

Operacja powinna też zostać wpisana do security audit log wraz z:

użytkownikiem
host_id
adresem klienta
wynikiem operacji
znacznikiem czasu

Obecnie kod wykonuje jedynie zwykłe:

tracing::info!(host_id = %id, "host removed");
HIGH-03: użytkownik readonly może zmieniać nazwy hostów

Ten sam błąd występuje w hosts_patch():

if state.sessions.get(&token).await.is_none() {
    return StatusCode::UNAUTHORIZED;
}

Po tym kod dowolnej zalogowanej osobie pozwala zmodyfikować display_name:

host.display_name = body.display_name.and_then(|n| {
    let t = n.trim().to_string();
    if t.is_empty() { None } else { Some(t) }
});

Nie ma kontroli roli administratora.

To mniejszy wpływ niż usunięcie hosta, ale nadal naruszenie integralności control plane. Możliwe jest także:

podszywanie się nazwą pod inny host;
wprowadzanie operatorów w błąd;
social engineering;
bardzo długie nazwy powodujące problemy w UI lub logach.

Globalny limit request body wynosi 16 KiB, ale brakuje semantycznego limitu długości display_name.

Poprawka:

const MAX_DISPLAY_NAME_LEN: usize = 128;

let display_name = body.display_name
    .map(|name| name.trim().to_owned())
    .filter(|name| !name.is_empty());

if display_name
    .as_ref()
    .is_some_and(|name| name.chars().count() > MAX_DISPLAY_NAME_LEN)
{
    return StatusCode::BAD_REQUEST;
}
HIGH-04: surowe wiadomości WebSocket są logowane

Gateway zapisuje cały tekst przesłany przez klienta:

tracing::trace!(raw = %text, "WS client → gateway");

W przypadku niepoprawnego JSON również zapisuje pełną zawartość:

tracing::warn!(
    error = %e,
    raw = %text,
    "invalid message from client"
);

Podobnie wiadomości agent → klient:

tracing::trace!(
    agent = %label,
    raw = %json,
    "agent → WS client"
);

Ponieważ WebSocket przenosi payloady operacyjne, logi mogą zawierać:

hasło sudo;
zawartość plików;
komendy terminala;
wyniki poleceń;
dane użytkowników;
logi systemowe;
konfiguracje sieciowe;
potencjalne klucze i tokeny obecne w plikach lub terminalu.

Nawet jeśli poziom TRACE nie jest domyślny, administrator może go włączyć podczas diagnostyki — dokładnie wtedy, gdy system ma problem i logi są częściej kopiowane do zewnętrznego systemu.

Poprawka

Logować wyłącznie metadane:

fn log_message_metadata(direction: &str, msg: &message::Message) {
    match msg {
        message::Message::Data { channel, payload } => {
            tracing::trace!(
                direction,
                channel = %channel,
                payload_bytes = payload.to_string().len(),
                kind = "data",
            );
        }
        message::Message::Open { channel, .. } => {
            tracing::trace!(
                direction,
                channel = %channel,
                kind = "open",
            );
        }
        message::Message::Close { channel, problem } => {
            tracing::trace!(
                direction,
                channel = %channel,
                has_problem = problem.is_some(),
                kind = "close",
            );
        }
        _ => {
            tracing::trace!(direction, kind = ?std::mem::discriminant(msg));
        }
    }
}

Dla błędnego JSON:

tracing::warn!(
    error = %e,
    payload_bytes = text.len(),
    "invalid message from client"
);

Nigdy:

raw = %text
password = %password
token = %session_id
HIGH-05: hasło sudo jest zapisywane jawnie w sessionStorage przy HTTP

Komentarz na początku secureStorage.ts twierdzi:

przy zwykłym HTTP hasło nie jest utrwalane.

Kod robi jednak coś odwrotnego:

const PLAIN_KEY = 'su_plain';

export async function saveSuperuserPassword(
  password: string,
): Promise<boolean> {
  if (!isSecureContext()) {
    sessionStorage.setItem(PLAIN_KEY, password);
    return true;
  }

  // ...
}

W komentarzu bezpośrednio przy funkcji autor określa plaintext fallback jako akceptowalny, ponieważ samo HTTP nie daje ochrony transportu. To błędne rozumowanie: brak TLS nie uzasadnia dodawania dodatkowego kanału trwałego przechowywania hasła. Kod bezpośrednio przeczy dokumentacji znajdującej się w tym samym pliku.

Wpływ

W trybie:

TENODERA_ALLOW_UNENCRYPTED=1

hasło może zostać odczytane przez:

sessionStorage.getItem('su_plain')

Może je pozyskać:

dowolny XSS;
złośliwe rozszerzenie przeglądarki;
kod uruchomiony w DevTools;
użytkownik z dostępem do profilu przeglądarki;
fragment aplikacji ze zmodyfikowanego supply chain.
Poprawka obowiązkowa
export async function saveSuperuserPassword(
  password: string,
): Promise<boolean> {
  if (!isSecureContext()) {
    return false;
  }

  try {
    const key = await getOrCreateKey();
    // szyfrowanie
    return true;
  } catch {
    return false;
  }
}

Jeszcze lepiej: nie utrwalać hasła w ogóle, nawet zaszyfrowanego.

let inMemoryPassword: string | null = null;
let expiresAt = 0;

export function setTemporaryPassword(
  password: string,
  ttlMs = 5 * 60_000,
): void {
  inMemoryPassword = password;
  expiresAt = Date.now() + ttlMs;
}

export function getTemporaryPassword(): string | null {
  if (Date.now() >= expiresAt) {
    inMemoryPassword = null;
    return null;
  }

  return inMemoryPassword;
}

Klucz AES zapisany w IndexedDB chroni przed prostym odczytaniem ciphertextu, ale nie chroni przed XSS. Skrypt działający w tym samym originie może użyć tego samego klucza przez Web Crypto API albo wywołać istniejącą funkcję deszyfrującą.

HIGH-06: instalator buduje zmienną gałąź main

Główny instalator jest przeznaczony do uruchamiania jako:

curl .../main/tenodera.sh | sudo bash

Następnie ustawia:

REPO="${TENODERA_REPO:-tenodera-io/tenodera}"
BRANCH="${TENODERA_BRANCH:-main}"

i pobiera:

TARBALL_URL="https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz"

curl -sSfL "$TARBALL_URL" | tar xz -C "$WORK_DIR"

Po pobraniu wykonuje kompilację i instalację kodu. Nie ma przypiętego commita, checksumy ani podpisu artefaktu.

Problemy
main jest zmienny.
Instalacja dzisiaj i jutro może zbudować inny kod.
Nie da się łatwo odtworzyć dokładnej wersji.
Przejęcie konta GitHub lub gałęzi oznacza wykonanie kodu jako root.
TLS zabezpiecza transport, ale nie zapewnia niezmienności źródła.
curl | sudo bash usuwa naturalny moment inspekcji skryptu.
Archiwum jest bezpośrednio przekazywane do tar, zanim zostanie zweryfikowane.
Właściwy model
VERSION="v0.2.13"
ARCHIVE="tenodera-${VERSION}.tar.gz"
CHECKSUMS="SHA256SUMS"
SIGNATURE="SHA256SUMS.minisig"

curl -fLO ".../releases/download/${VERSION}/${ARCHIVE}"
curl -fLO ".../releases/download/${VERSION}/${CHECKSUMS}"
curl -fLO ".../releases/download/${VERSION}/${SIGNATURE}"

minisign -Vm "$CHECKSUMS" -P "$TENODERA_RELEASE_PUBLIC_KEY"
sha256sum --check --ignore-missing "$CHECKSUMS"

tar --no-same-owner \
    --no-same-permissions \
    -xzf "$ARCHIVE"

Minimum to przypięty commit SHA:

COMMIT="0123456789abcdef..."
TARBALL_URL="https://github.com/${REPO}/archive/${COMMIT}.tar.gz"

Commita również dobrze byłoby porównać z podpisanym tagiem release.

4. Analiza wspólnego protokołu
4.1. protocol/src/auth.rs

Moduł buduje payload podpisywany podczas uwierzytelniania agenta.

Struktura danych jest zbliżona do:

"tenodera-agent-auth-v1\0"
nonce
hostname_length
hostname
gateway_id_length
gateway_id

Projekt zawiera:

domain separation;
wersję protokołu w prefiksie;
nonce o długości 32 bajtów;
length-prefixing zmiennych pól;
powiązanie podpisu z konkretnym gatewayem.

To dobry projekt kryptograficzny. Chroni między innymi przed użyciem podpisu w innym kontekście protokołu.

Problem: niekontrolowane konwersje długości

Kod używa odpowiednika:

(hostname.len() as u16).to_be_bytes()
(gateway_id.len() as u16).to_be_bytes()

Dla danych dłuższych niż u16::MAX długość zostanie obcięta modulo 65536.

W praktyce hostname będzie znacznie krótszy, ale funkcja protokołu powinna sama wymuszać swój kontrakt:

fn append_len_prefixed(
    output: &mut Vec<u8>,
    value: &[u8],
) -> Result<(), AuthPayloadError> {
    let len = u16::try_from(value.len())
        .map_err(|_| AuthPayloadError::FieldTooLong)?;

    output.extend_from_slice(&len.to_be_bytes());
    output.extend_from_slice(value);
    Ok(())
}
Brakujące testy

Powinny istnieć testy:

#[test]
fn different_gateway_id_changes_payload() {}

#[test]
fn maximum_hostname_length_is_accepted() {}

#[test]
fn oversized_hostname_is_rejected() {}

#[test]
fn embedded_null_bytes_do_not_create_ambiguity() {}

#[test]
fn field_boundaries_are_unambiguous() {}
4.2. protocol/src/channel.rs

ChannelId:

nie może być pusty;
ma limit 128 znaków;
dopuszcza ASCII alfanumeryczne, - i _.

To jest poprawna walidacja identyfikatora używanego jako klucz map i tras.

Problemem są implementacje:

impl From<String> for ChannelId
impl From<&str> for ChannelId

które opierają się na:

debug_assert!(validate(...).is_ok());

debug_assert! nie działa w standardowym buildzie release. Oznacza to, że kod wewnętrzny może utworzyć niepoprawny ChannelId, mimo że typ sugeruje zachowanie niezmiennika.

Właściwe rozwiązanie
impl TryFrom<String> for ChannelId {
    type Error = ChannelIdError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        validate_channel_id(&value)?;
        Ok(Self(value))
    }
}

impl FromStr for ChannelId {
    type Err = ChannelIdError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::try_from(value.to_owned())
    }
}

Jeżeli potrzebny jest szybki konstruktor wewnętrzny:

impl ChannelId {
    pub(crate) fn new_unchecked(value: String) -> Self {
        Self(value)
    }
}

Nazwa wyraźnie informuje wtedy o pominięciu walidacji.

4.3. protocol/src/message.rs

Protokół używa serde i tagged JSON. Warianty obejmują między innymi:

Hello
Challenge
ChallengeResponse
Pending
HelloAck
Open
Ready
Data
Control
Close
Auth
Ping
Pong

Aktualny numer protokołu to 2.

Dobrą decyzją jest własna implementacja Debug dla credentials, która redaguje dane uwierzytelniające. Problem polega na tym, że inne części gatewaya omijają tę ochronę, serializując całą wiadomość do JSON i logując string.

serde_json::Value

Wiele payloadów jest reprezentowanych jako:

serde_json::Value

Zalety:

szybkie dodawanie handlerów;
elastyczność;
kompatybilność z frontendem;
prosty streaming danych.

Wady:

brak compile-time schema;
walidacja rozproszona po handlerach;
większa podatność na pominięcie pola lub błędny typ;
trudniejsza ewolucja API;
trudniejsze generowanie testów;
autoryzacja jest dodawana przez mutację JSON.

Docelowo warto użyć typowanych requestów:

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case")]
enum ServiceRequest {
    List,
    Start { unit: UnitName },
    Stop { unit: UnitName },
    Restart { unit: UnitName },
}

Wspólny protokół powinien też definiować:

const MAX_FRAME_SIZE: usize = 1024 * 1024;
const MAX_PAYLOAD_SIZE: usize = 512 * 1024;
const MAX_CHANNELS: usize = 512;

i egzekwować je na obu końcach.

5. Gateway
5.1. main.rs

main.rs pełni zbyt wiele ról:

parsowanie konfiguracji;
inicjalizacja TLS;
tworzenie stanu aplikacji;
rejestracja tras;
endpointy tokenów;
endpointy pending agents;
endpointy hostów;
health checks;
bootstrap;
obsługa lifecycle procesu.

Plik ma około 728 linii kodu właściwego.

To nadal możliwe do utrzymania, ale podział byłby czytelniejszy:

api/
├── hosts.rs
├── tokens.rs
├── pending.rs
├── health.rs
└── mod.rs

startup/
├── config.rs
├── privileges.rs
├── tls.rs
└── router.rs
Dobre elementy

Router ustawia globalny limit request body:

DefaultBodyLimit::max(1024 * 16)

Po zbindowaniu socketu i wczytaniu TLS gateway porzuca uprawnienia roota:

let listener = TcpListener::bind(bind_addr).await?;
drop_privileges()?;

To dobry lifecycle: proces zachowuje roota tylko tak długo, jak jest to potrzebne do początkowej konfiguracji.

Brak centralnej polityki autoryzacji

Każdy handler ręcznie implementuje:

extract_bearer_token()
sessions.get()
require_admin()

To właśnie doprowadziło do pominięcia uwierzytelnienia w hosts_list oraz kontroli roli w hosts_remove i hosts_patch.

Należy użyć Axum extractorów:

pub struct Authenticated(pub Session);

#[async_trait]
impl<S> FromRequestParts<S> for Authenticated
where
    Arc<AppState>: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = StatusCode;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &S,
    ) -> Result<Self, Self::Rejection> {
        // bearer + get_valid()
    }
}

pub struct Admin(pub Session);

Wtedy sygnatura wymusza wymagania:

async fn hosts_list(
    Authenticated(session): Authenticated,
    State(state): State<Arc<AppState>>,
) -> Json<Value>

oraz:

async fn hosts_remove(
    Admin(session): Admin,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> StatusCode

Nie da się wtedy przypadkowo „zapomnieć” o sprawdzeniu.

5.2. auth.rs

Logowanie odbywa się przez PAM, czyli użytkownik korzysta z lokalnego konta systemowego. Rola administratora jest wyprowadzana z przynależności do odpowiedniej grupy/sudo. Gateway ma także rate limiting logowania per IP.

To dobry model dla lokalnego narzędzia administracyjnego:

brak osobnej bazy haseł;
zgodność z polityką systemową;
możliwość użycia LDAP/SSSD przez PAM;
respektowanie blokad kont i polityk haseł.
Ryzyka

PAM powinien działać w małym, wydzielonym helperze z bardzo ograniczonym interfejsem. Należy upewnić się, że:

hasło nie trafia w argumenty procesu;
hasło nie jest zmienną środowiskową;
stderr helpera nie wraca bezpośrednio do klienta;
odpowiedź nie ujawnia, czy konto istnieje;
istnieje bezwzględny timeout;
helper nie dziedziczy niepotrzebnych deskryptorów;
bufor hasła jest zerowany.

Odpowiedzi logowania powinny być generyczne:

{
  "error": "invalid_credentials"
}

Nie:

{
  "error": "user_exists_but_is_locked"
}
5.3. session.rs

Sesje:

używają UUIDv4;
są przechowywane w pamięci;
mają idle timeout około 15 minut;
mają maksymalny lifetime około 4 godzin;
są okresowo usuwane przez reaper.

In-memory sessions są prostym i bezpiecznym rozwiązaniem dla pojedynczego gatewaya, ale:

restart unieważnia wszystkie sesje;
nie pozwalają na horizontal scaling;
każde odczytanie musi sprawdzać expiry;
token pozostaje bearer secretem.
Problem z walidacją expiry

Jeżeli SessionStore::get() zwraca wpis z mapy bez natychmiastowego sprawdzenia czasu wygaśnięcia, poprawność zależy od pracy okresowego reapera. Między faktycznym expiry a kolejnym przebiegiem reapera sesja może być nadal akceptowana.

Powinno być:

pub async fn get_valid(&self, id: &str) -> Option<Session> {
    let now = Instant::now();
    let mut sessions = self.sessions.write().await;

    let session = sessions.get(id)?;

    if session.is_expired(now) {
        sessions.remove(id);
        return None;
    }

    Some(session.clone())
}

Wszystkie endpointy i WebSocket powinny używać wyłącznie get_valid().

Logowanie session ID

Session ID jest bearer tokenem. Nie powinien pojawiać się w:

Debug struktury sesji;
komunikatach logout;
błędach;
tracing spanach;
panic dumpach.

W kodzie logout/session debug widoczne są miejsca, w których ID może zostać zalogowane.

Bezpieczny Debug:

impl fmt::Debug for Session {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Session")
            .field("id", &"[REDACTED]")
            .field("user", &self.user)
            .field("role", &self.role)
            .field("created_at", &self.created_at)
            .finish()
    }
}
5.4. security_headers.rs

Middleware dodaje między innymi:

CSP;
X-Frame-Options;
X-Content-Type-Options;
Referrer Policy;
Permissions Policy;
no-store dla API;
kontrolę Origin/Referer dla żądań mutujących.

To jest dobry fundament.

Problem: porównywanie z Host

Polityka same-origin opiera się na wartości nagłówka Host. Nagłówek ten pochodzi od klienta lub reverse proxy. Bez jawnej konfiguracji trusted proxy może być manipulowany.

Lepszy model:

[http]
public_origins = [
    "https://tenodera.example.internal",
    "https://10.10.10.5"
]

trusted_proxies = [
    "127.0.0.1/32",
    "::1/128"
]

Następnie:

if !config.public_origins.contains(parsed_origin.as_str()) {
    return Err(StatusCode::FORBIDDEN);
}

Nie należy samodzielnie parsować URL przez operacje na stringach. Powinien zostać użyty typ url::Url.

HSTS za Caddy

Gateway dodaje HSTS tylko, gdy sam wie, że działa z TLS. Przy standardowej instalacji TLS kończy się na Caddy, a gateway otrzymuje HTTP przez loopback. W takim układzie gateway może nie dodać HSTS. Caddy również nie musi robić tego automatycznie.

Caddyfile powinien zawierać:

header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "no-referrer"
}

includeSubDomains należy zastosować tylko wtedy, gdy wszystkie subdomeny rzeczywiście obsługują HTTPS.

5.5. ws.rs

WebSocket:

sprawdza Origin;
wykonuje upgrade;
oczekuje pierwszej wiadomości uwierzytelniającej;
weryfikuje sesję;
multipleksuje logical channels;
przekazuje wiadomości agentom;
okresowo sprawdza ważność sesji.

UI nie przekazuje session ID w query stringu — wysyła auth message jako pierwszą ramkę. Jest to bezpieczniejsze niż token w URL, ponieważ URL często trafia do historii, access logów i systemów analitycznych. Dokumentacja zawierająca /api/ws?session_id=... jest w tym zakresie nieaktualna.

Limit kanałów

Gateway ma limit około 512 kanałów na sesję. To dobra ochrona przed nieograniczonym wzrostem mapy kanałów.

Duplikaty ChannelId

Przy Open należy bezwzględnie odrzucić kanał, który już istnieje:

if channel_routes.contains_key(&channel) {
    send_close(
        &sink,
        channel,
        "duplicate-channel-id",
    ).await;
    continue;
}

Nadpisanie istniejącej trasy może spowodować:

pozostawienie starego taska;
utratę sendera;
przeplatanie danych;
wyciek zasobów;
niejednoznaczną obsługę Close.
Frame limits

Należy jawnie ustawić:

WebSocketUpgrade::max_frame_size(...)
WebSocketUpgrade::max_message_size(...)

Przykładowo:

const MAX_WS_FRAME: usize = 1024 * 1024;
const MAX_WS_MESSAGE: usize = 2 * 1024 * 1024;

W przeciwnym razie bezpieczeństwo zależy od domyślnych wartości frameworka i biblioteki.

6. Uwierzytelnienie agentów
6.1. Handshake

Handshake wykorzystuje:

klucz Ed25519 agenta;
losowy nonce;
podpis challenge;
fingerprint klucza;
znany klucz hosta albo bootstrap token;
stan pending dla nieznanych agentów;
verify_strict;
typ AuthenticatedAgent, reprezentujący zakończone uwierzytelnienie.

To jeden z lepiej zaprojektowanych fragmentów projektu.

Zalety type-state

Zamiast przekazywania:

Agent {
    authenticated: bool,
}

kod używa osobnego typu po autoryzacji. Dzięki temu funkcje wymagające poprawnego handshake mogą przyjmować:

fn register(agent: AuthenticatedAgent)

i nie muszą ponownie sprawdzać flagi.

6.2. Bootstrap tokeny

Tokeny są przechowywane w pamięci i porównywane w sposób constant-time. To właściwy kierunek, ale nie powinny być przechowywane w postaci jawnej.

Lepszy model:

struct StoredBootstrapToken {
    id: Uuid,
    digest: [u8; 32],
    expires_at: Instant,
    uses_remaining: u32,
}

Digest:

fn token_digest(server_key: &[u8; 32], token: &[u8]) -> [u8; 32] {
    *blake3::keyed_hash(server_key, token).as_bytes()
}

Weryfikacja:

let digest = token_digest(&key, supplied_token.as_bytes());
registry.get(&digest)

Korzyści:

wyciek pamięci nie ujawnia bezpośrednio tokenów;
wyszukiwanie jest O(1);
nie trzeba wykonywać linear scan;
łatwiej ograniczać użycia i audytować.

Dla porównań constant-time lepiej użyć sprawdzonej biblioteki:

use subtle::ConstantTimeEq;

zamiast utrzymywać własną implementację.

6.3. Pending registry

Nieznani agenci mogą pozostać w stanie pending nawet przez 24 godziny, z globalnym limitem około 100 wpisów.

Atakujący może próbować zapełnić registry losowymi kluczami. Potrzebne są:

limit per adres IP;
limit per subnet;
rate limit handshake;
krótsze pending TTL, np. 15–60 minut;
LRU eviction;
metryka liczby odrzuceń;
cooldown po błędnych podpisach.

Przykład:

const MAX_PENDING_TOTAL: usize = 100;
const MAX_PENDING_PER_IP: usize = 3;
const PENDING_TTL: Duration = Duration::from_secs(30 * 60);
6.4. Auto-enrollment z loopback

Lokalny agent może być automatycznie zatwierdzony, jeśli połączenie pochodzi z loopback. To jest wygodne, ale zaufanie zależy od prawidłowego ustalenia rzeczywistego adresu klienta.

Jeżeli gateway kiedykolwiek zacznie ufać X-Forwarded-For od dowolnego klienta, atakujący może spróbować podać:

X-Forwarded-For: 127.0.0.1

Dlatego:

X-Forwarded-For wolno interpretować wyłącznie,
gdy bezpośredni peer należy do configured trusted_proxies.

Auto-enrollment powinien być dodatkowo kontrolowany ustawieniem:

[agents]
allow_loopback_auto_enrollment = true

i emitować wyraźny audit event.

7. Agent systemowy
7.1. identity.rs

Klucz prywatny agenta jest przechowywany domyślnie w:

/var/lib/tenodera/agent.key

Katalog ma tryb 0700, a plik tworzony jest z 0600 i create_new, z wykorzystaniem systemowego generatora losowego. Po zapisie wykonywany jest sync_all().

To dobry kod.

Dodatkowy hardening

Przy otwieraniu istniejącego klucza należy użyć:

OpenOptionsExt::custom_flags(libc::O_NOFOLLOW)

oraz sprawdzić:

metadata.file_type().is_file()
metadata.uid() == 0
metadata.mode() & 0o777 == 0o600
metadata.nlink() == 1

Przykładowo:

fn validate_key_metadata(meta: &Metadata) -> anyhow::Result<()> {
    if !meta.file_type().is_file() {
        anyhow::bail!("agent key is not a regular file");
    }

    if meta.uid() != 0 {
        anyhow::bail!("agent key is not root-owned");
    }

    if meta.mode() & 0o077 != 0 {
        anyhow::bail!("agent key permissions are too broad");
    }

    Ok(())
}

Ryzyko symlink attack jest ograniczone przez root-owned katalog 0700, ale zabezpieczenie powinno wynikać z samego kodu.

7.2. main.rs

Agent realizuje reconnect z exponential backoff od około 1 do 30 sekund.

Brakuje jittera. Gdy gateway wróci po awarii, wszystkie agenty uruchomione w podobnym czasie mogą połączyć się jednocześnie.

Zamiast:

sleep(backoff).await;
backoff = (backoff * 2).min(MAX_BACKOFF);

należy zastosować full jitter:

use rand::Rng;

let max_ms = backoff.as_millis() as u64;
let delay_ms = rand::rng().random_range(0..=max_ms);

tokio::time::sleep(Duration::from_millis(delay_ms)).await;
backoff = (backoff * 2).min(MAX_BACKOFF);

Dobrze byłoby dodać stabilizację:

połączenie trwało >60 s → reset backoff do 1 s
połączenie trwało <5 s  → dalszy wzrost backoff
7.3. Niebezpieczny tryb TLS

Agent posiada ustawienie w rodzaju:

TENODERA_AGENT_ACCEPT_INSECURE=1

które pozwala zaakceptować dowolny certyfikat. Jest to operacyjny footgun.

Taki tryb powinien:

być niedostępny w buildzie release;
albo działać tylko dla loopback;
wymagać dodatkowej flagi CLI;
emitować powtarzalne ostrzeżenie;
nigdy nie zezwalać na słabe schematy podpisu, np. SHA-1;
nie współpracować z bootstrap enrollment.

Lepsze rozwiązanie dla wewnętrznego CA:

TENODERA_CA_CERT=/etc/tenodera/ca.crt

i dołączenie konkretnego certyfikatu CA do rustls::RootCertStore.

7.4. router.rs

Router rejestruje wiele handlerów, między innymi dla:

system info
processes
systemd
users
packages
storage
network
containers
SSH
terminal
files
security
logs

Dokumentacja podaje mniej handlerów niż rzeczywisty kod, co wskazuje na drift dokumentacji.

Router utrzymuje mapy:

ChannelId → handler/task
ChannelId → shutdown signal
Duplikat payload type

Jeżeli rejestracja handlerów wykonuje zwykłe:

handlers.insert(handler.payload_type(), handler);

duplikat po prostu zastąpi poprzedni handler.

Startup powinien zakończyć się błędem:

if handlers
    .insert(payload_type.clone(), handler)
    .is_some()
{
    anyhow::bail!(
        "duplicate handler registration: {payload_type}"
    );
}
Duplikat kanału

Tak samo należy odrzucić drugi Open dla istniejącego ChannelId.

Task lifecycle

Streaming handler jest uruchamiany jako detached Tokio task, a router przechowuje sygnał shutdown, ale niekoniecznie jego JoinHandle. Jeżeli handler ignoruje shutdown, task może pozostać aktywny.

Powinno być:

struct RunningChannel {
    shutdown: watch::Sender<bool>,
    task: JoinHandle<()>,
}

Przy zamknięciu:

let _ = channel.shutdown.send(true);

match timeout(Duration::from_secs(2), &mut channel.task).await {
    Ok(_) => {}
    Err(_) => channel.task.abort(),
}
7.5. handler.rs

Handler bazuje na stringowym typie payloadu oraz JSON-ie:

trait Handler {
    fn payload_type(&self) -> &'static str;
    async fn handle(...);
}

Brakuje deklaratywnych metadata bezpieczeństwa:

enum RequiredRole {
    Readonly,
    Admin,
}

enum OperationRisk {
    ReadOnly,
    Mutating,
    PrivilegeEscalation,
}

struct HandlerMetadata {
    payload_type: &'static str,
    required_role: RequiredRole,
    operation_risk: OperationRisk,
    timeout: Duration,
    max_request_bytes: usize,
    max_response_bytes: usize,
}

Dzisiaj kontrola dostępu jest implementowana wewnątrz handlerów. To zwiększa prawdopodobieństwo pominięcia require_admin().

Docelowo router powinien wymuszać politykę przed wywołaniem handlera:

if handler.metadata().required_role == RequiredRole::Admin
    && context.role != Role::Admin
{
    return forbidden(channel);
}
7.6. util.rs

To najbardziej wrażliwa część agenta.

Kod:

wyszukuje użytkownika przez NSS;
wykonuje initgroups;
zmienia GID;
zmienia UID;
uruchamia sudo;
przekazuje hasło przez stdin;
przechwytuje stdout i stderr.

Sam proces:

initgroups → setgid → setuid

jest poprawny. Ważna jest kolejność: supplementary groups muszą zostać ustawione przed utratą roota.

Problem: sudo sh -c

Do zapisu plików kod wykorzystuje schemat:

base64 data
    ↓
sudo sh -c '...'

To podważa least privilege.

Jeżeli użytkownik lub policy ma pozwalać agentowi na konkretny helper, reguła sudo może ograniczać:

user ALL=(root) /usr/lib/tenodera/tenodera-file-helper

Ale dla:

user ALL=(root) /bin/sh

użytkownik praktycznie otrzymuje dowolny root shell.

Bezpieczniejsza architektura

Dedykowany helper:

tenodera-file-helper write
tenodera-file-helper chmod
tenodera-file-helper chown

Dane powinny być przesyłane przez stdin w ustrukturyzowanym formacie, a helper powinien:

przyjmować allowlisted operacje;
otwierać pliki z O_NOFOLLOW;
odrzucać ..;
sprawdzać canonical path;
limitować rozmiar;
używać openat2() z RESOLVE_BENEATH;
nie uruchamiać shella;
nie interpretować inputu jako command line.

Przykład API:

enum FileOperation {
    Write {
        path: PathBuf,
        mode: Option<u32>,
        expected_sha256: Option<String>,
    },
}
Brak timeoutów

Każda zewnętrzna komenda musi posiadać timeout:

let result = tokio::time::timeout(
    Duration::from_secs(30),
    child.wait_with_output(),
)
.await;

Samo timeout() nie wystarczy, ponieważ po anulowaniu future proces potomny może nadal działać. Należy:

uruchomić proces w osobnej process group;
po timeout wysłać SIGTERM;
po grace period wysłać SIGKILL;
zebrać zombie przez wait().
Nieograniczone wait_with_output()

wait_with_output() może zebrać dowolną ilość danych do RAM. Komenda taka jak:

yes

albo intensywny journal może spowodować memory exhaustion.

Potrzebny jest bounded reader:

const MAX_OUTPUT: usize = 4 * 1024 * 1024;

Po przekroczeniu:

przerwać proces
oznaczyć output jako truncated
zwrócić jednoznaczny kod błędu
PATH injection

Polecenia systemowe powinny używać:

ścieżek absolutnych;
albo stałego, zaufanego PATH.
command.env_clear();
command.env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin");
command.env("LANG", "C.UTF-8");

Nie należy dziedziczyć:

LD_PRELOAD
LD_LIBRARY_PATH
PYTHONPATH
RUST_LOG
BASH_ENV
ENV

z procesu nadrzędnego.

8. Frontend
8.1. transport.ts

Transport:

tworzy WebSocket;
wysyła auth message;
utrzymuje mapę kanałów;
realizuje request/response;
ma reconnect logic;
rozdziela wiadomości między subskrybentów.
Brak fail-fast przy rozłączonym WebSocket

Jeżeli kod używa:

this.ws?.send(...)

wywołanie przy null może zostać cicho pominięte. Wyższa warstwa otrzyma handle lub promise, które zakończy się dopiero timeoutem.

Powinno być:

private send(message: ProtocolMessage): void {
  if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
    throw new TransportError('WebSocket is not connected');
  }

  this.ws.send(JSON.stringify(message));
}
Reconnect bez jittera

Tak samo jak agent, frontend powinien dodać losowość:

const base = Math.min(
  MAX_DELAY,
  INITIAL_DELAY * 2 ** attempt,
);

const delay = Math.random() * base;
Nieograniczony wynik requestu

Jeżeli request zbiera wszystkie odpowiedzi w tablicy przez 30 sekund, serwer może przesłać bardzo dużo elementów. Potrzebne są:

const MAX_ITEMS = 10_000;
const MAX_BYTES = 8 * 1024 * 1024;

i przerwanie kanału po przekroczeniu limitu.

Logowanie surowych danych serwera

Frontend wykonuje:

console.warn('invalid message from server', event.data);

Może to umieścić w DevTools dane, których operator nie zamierzał utrwalać. Należy logować długość i błąd parsera, nie treść.

8.2. SuperuserContext.tsx

Hasło jest przechowywane jako JavaScript string.

Stringi JS są:

immutable;
kopiowane;
zarządzane przez garbage collector;
niemożliwe do deterministycznego wyzerowania.

Nie da się zagwarantować usunięcia ich z pamięci. Można jednak ograniczyć ryzyko:

nie zapisywać w storage;
utrzymywać przez krótki czas;
usuwać przy zmianie widoczności strony;
usuwać przy rozłączeniu;
wymagać ponownego wpisania dla szczególnie niebezpiecznych operacji.
window.addEventListener('pagehide', clearPassword);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearPassword();
});

Najlepszym rozwiązaniem byłoby niewysyłanie hasła sudo z przeglądarki dla każdej operacji. Gateway/agent mógłby używać krótkotrwałego, ograniczonego privilege authorization grant, wydanego po jednorazowym PAM re-auth:

hasło → PAM helper
       ↓
krótkotrwały grant:
- user
- host ID
- dozwolony zakres operacji
- expiry 2–5 minut
- random nonce
- podpis/MAC gatewaya

Hasło nie musiałoby wtedy podróżować w każdym payloadzie WebSocket.

9. Instalacja i utrzymanie
9.1. Caddy

Instalator:

pozostawia gateway na loopback;
instaluje Caddy;
wystawia panel po HTTPS;
używa adresów interfejsów hosta;
w razie niepowodzenia Caddy nie wystawia gatewaya jako plain HTTP do sieci.

To jest poprawna decyzja.

Problemy operacyjne:

instalowana jest „najnowsza” wersja Caddy, bez pinning;
instalator dodaje zewnętrzne repozytorium;
automatycznie modyfikuje system;
nie ma jednoznacznego rollbacku transakcyjnego.

Dla produkcji należy:

przypiąć minimalną lub konkretną wersję;
dokumentować klucz repozytorium;
generować backup zmienianych plików;
walidować Caddyfile przez caddy validate;
dopiero po walidacji wykonywać restart;
wykonywać atomic replace konfiguracji.
9.2. pacman -Sy

Instalator dla systemów Arch używa:

pacman -Sy --noconfirm --needed make

Na Arch/CachyOS jest to zła praktyka, ponieważ może prowadzić do partial upgrade. Powinno być:

pacman -Syu --noconfirm --needed make

albo instalator powinien przerwać i poinformować użytkownika:

Zaktualizuj system przez sudo pacman -Syu,
następnie uruchom instalator ponownie.

Bezpieczniejszy wariant dla narzędzia produkcyjnego to nie wykonywać pełnej aktualizacji automatycznie, tylko sprawdzić zależności i wyświetlić polecenie.

10. Drift dokumentacji

W kilku miejscach dokumentacja nie odpowiada aktualnemu kodowi:

dokumentacja WebSocket wspomina token w query stringu, ale UI wysyła auth frame;
niektóre dokumenty opisują starszy model gateway–agent;
liczba handlerów w agencie jest nieaktualna;
komentarz secureStorage.ts twierdzi, że hasło nie jest utrwalane przez HTTP, podczas gdy kod zapisuje je jawnie;
niektóre fragmenty threat modelu opisują starsze ustawienia bind/TLS;
komentarze sesji wspominają zeroizację hasła w gatewayu, choć obecna struktura sesji go nie zawiera.

W projekcie administracyjnym drift dokumentacji jest problemem bezpieczeństwa, ponieważ operator może wdrożyć system na podstawie nieaktualnych założeń.

Zalecam automatyczne testy dokumentacji:

README endpointy ↔ router
README liczba handlerów ↔ registry
opis secure storage ↔ test browser context
default bind ↔ Config::default()
protocol version ↔ dokumentacja
11. Mocne strony kodu

Żeby ocena była kompletna: projekt nie jest napisany niedbale. Ma wiele dobrych elementów.

Kryptografia
Ed25519;
verify_strict;
nonce z systemowego CSPRNG;
domain separation;
gateway ID w podpisywanym payloadzie;
fingerprinting;
osobny stan po uwierzytelnieniu.
Uprawnienia plików
katalog klucza 0700;
klucz 0600;
create_new;
synchronizacja zapisu.
Gateway
domyślny bind do loopback;
HTTPS przez reverse proxy;
porzucanie roota;
limit body 16 KiB;
CSP;
frame protection;
CSRF checks;
no-store dla API;
login rate limiting;
limity liczby kanałów;
idle i absolute session timeout.
Agent
brak portu nasłuchującego;
połączenie wychodzące;
osobne handlery;
sygnały shutdown;
ograniczone kolejki kanałów;
deny-by-default w części kontroli roli;
inicjalizacja grup przed setuid.
Frontend
token WebSocket nie jest przekazywany przez URL;
AES-GCM przy secure context;
klucz Web Crypto jest non-extractable;
logiczna separacja transportu i komponentów UI.
12. Kolejność napraw
P0 — przed jakimkolwiek publicznym wdrożeniem
Dodać uwierzytelnienie do GET /api/hosts.
Wymusić admina dla DELETE/PATCH /api/hosts/{id}.
Usunąć raw WebSocket payload z logów.
Usunąć plaintext fallback hasła sudo.
Ujednolicić sprawdzanie ważności sesji.
Dodać audit log do wszystkich operacji control-plane.
P1 — przed wdrożeniem produkcyjnym w sieci firmowej
Zastąpić sudo sh -c dedykowanym helperem.
Dodać timeouty i limity outputu procesów.
Ustawić maksymalny rozmiar ramek WebSocket.
Odrzucać duplicate ChannelId.
Przechowywać JoinHandle tasków kanałów.
Dodać trusted proxy configuration.
Dodać HSTS w Caddy.
Przypiąć wersje instalowanych artefaktów.
Weryfikować podpisy/checksumy.
Naprawić pacman -Sy.
P2 — hardening i jakość
Typowane payloady zamiast szerokiego serde_json::Value.
Deklaratywna polityka role/risk per handler.
Jitter reconnect.
Hashowanie bootstrap tokenów.
Per-IP pending limits.
O_NOFOLLOW i kontrola metadata klucza.
Limity długości nazw i pól.
Aktualizacja dokumentacji.
SBOM i provenance.
Fuzzing parsera protokołu.
13. Minimalny zestaw testów bezpieczeństwa
REST authorization
# Musi zwrócić 401
curl -k -i https://TENODERA/api/hosts

# Readonly token: odczyt może zwrócić 200
curl -k -i \
  -H "Authorization: Bearer $READONLY_TOKEN" \
  https://TENODERA/api/hosts

# Readonly nie może usuwać: oczekiwane 403
curl -k -i \
  -X DELETE \
  -H "Authorization: Bearer $READONLY_TOKEN" \
  https://TENODERA/api/hosts/HOST_ID

# Readonly nie może modyfikować: oczekiwane 403
curl -k -i \
  -X PATCH \
  -H "Authorization: Bearer $READONLY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"display_name":"modified"}' \
  https://TENODERA/api/hosts/HOST_ID
Log leakage

Uruchomić gateway z TRACE, wykonać testową operację z unikalnym sekretem:

TENODERA_SECRET_LEAK_TEST_7f42a96c

Następnie:

grep -R --fixed-strings \
  'TENODERA_SECRET_LEAK_TEST_7f42a96c' \
  /var/log/tenodera*

Wynik musi być pusty.

Plain HTTP storage

W browser test:

expect(
  sessionStorage.getItem('su_plain'),
).toBeNull();
Channel collision
Open channel=test
Open channel=test

Oczekiwane:
Close(channel=test, problem=duplicate-channel-id)
Oversized frames

Przesłać:

1 MiB - 1
1 MiB
1 MiB + 1
10 MiB

i sprawdzić kontrolowane zamknięcie połączenia bez wzrostu pamięci.

Reconnect storm

Uruchomić kilkaset agentów testowych, zrestartować gateway i zmierzyć rozkład reconnectów. Bez jittera wystąpi wyraźny impuls w jednej sekundzie.

14. Polecenia do pełnej lokalnej walidacji

Na CachyOS:

sudo pacman -Syu --needed \
  base-devel \
  rustup \
  nodejs \
  npm \
  openssl \
  pam \
  pkgconf

Rust:

rustup default stable
rustup component add clippy rustfmt
cargo install cargo-audit cargo-deny

Backend panelu:

cd panel

cargo fmt --all -- --check
cargo check --workspace --all-targets
cargo test --workspace --all-targets
cargo clippy --workspace --all-targets --all-features -- \
  -D warnings
cargo audit
cargo deny check

Agent:

cd agent

cargo fmt --all -- --check
cargo check --all-targets
cargo test --all-targets
cargo clippy --all-targets --all-features -- \
  -D warnings
cargo audit

Frontend:

cd panel/ui

npm ci
npm run build
npm audit

Jeżeli w package.json istnieją odpowiednie skrypty:

npm run lint
npm run typecheck
npm test

Test zależności Rust powinien również wykrywać duplikaty krytycznych bibliotek:

cargo tree --duplicates

Sanity check unsafe:

rg -n '\bunsafe\b|Command::new|sh -c|sudo|setuid|setgid|from_raw' \
  agent panel protocol

Sekrety i logowanie:

rg -n \
  'raw\s*=|password|session_id|token|Authorization|console\.(log|warn|error)' \
  agent panel protocol
15. Ostateczna rekomendacja

Tenodera jest projektem obiecującym, ale obecna wersja nie powinna być wystawiana bezpośrednio do publicznego Internetu.

Architektura bazowa jest dobra: outbound agents, Ed25519, PAM, Rust, loopback gateway i Caddy to właściwe decyzje. Największy problem nie leży w ogólnej koncepcji, lecz w kilku pominięciach na granicach zaufania:

jeden handler nie sprawdza sesji;
dwa handlery nie sprawdzają roli;
warstwa diagnostyczna loguje poufne payloady;
frontend świadomie zapisuje hasło jawnie w trybie HTTP;
instalator nie zapewnia reprodukowalności ani integralności wersji;
agent wymaga zbyt szerokiego modelu sudo.

Po naprawieniu pozycji P0 i P1 projekt może być sensownym panelem administracyjnym dla sieci prywatnej, szczególnie za VPN-em, reverse proxy i dodatkową kontrolą dostępu. Przed szerszym wdrożeniem potrzebne są jeszcze testy dynamiczne, fuzzing protokołu, dependency audit i niezależny security review.