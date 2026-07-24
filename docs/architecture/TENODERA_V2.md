Tak — przy założeniu, że Tenodera ma obsługiwać **setki użytkowników, wielu administratorów i znaczną liczbę hostów**, PostgreSQL powinien być **obowiązkowym fundamentem**, a nie opcjonalnym dodatkiem.

Jednocześnie „utrwalać wszystko” powinno znaczyć:

> Utrwalamy cały stan biznesowy, bezpieczeństwa i operacyjny, ale nie zapisujemy haseł ani krótkotrwałych sekretów.

# Tenodera v2 — poprawiona architektura

```text
┌────────────────────┐
│ Przeglądarka       │
│ React / TypeScript │
└─────────┬──────────┘
          │ HTTPS / WSS
          ▼
┌────────────────────────────────────┐
│ Tenodera Server                    │
│                                    │
│ działa bez uprawnień root          │
│                                    │
│ - API                              │
│ - uwierzytelnienie                 │
│ - sesje                            │
│ - RBAC                             │
│ - polityki                         │
│ - SSH connection manager           │
│ - kolejka operacji                 │
│ - audit                            │
└─────────┬──────────────────┬───────┘
          │                  │
          │ SQL              │ SSH
          ▼                  ▼
┌────────────────────┐  ┌────────────────────────┐
│ PostgreSQL         │  │ Zarządzany host        │
│                    │  │                        │
│ users              │  │ sshd                   │
│ sessions           │  │   ↓                    │
│ hosts              │  │ tenodera-bridge        │
│ jobs               │  │ jako użytkownik        │
│ audit              │  │   ↓                    │
│ inventory          │  │ sudo / polkit          │
│ history            │  │   ↓                    │
│ policies           │  │ Linux                  │
└────────────────────┘  └────────────────────────┘
```

Podstawowy przepływ będzie prosty:

```text
browser
→ Tenodera Server
→ PostgreSQL: autoryzacja i zapis operacji
→ SSH
→ tenodera-bridge
→ sudo / lokalny system
→ PostgreSQL: wynik i audit
```

# Rola PostgreSQL

PostgreSQL będzie źródłem prawdy dla całego control plane.

Nie tylko zastąpi `hosts.json`, ale również:

* stan sesji;
* użytkowników;
* role;
* przypisania uprawnień;
* konfigurację hostów;
* historię kluczy SSH;
* kolejkę operacji;
* wyniki;
* inventory;
* audit;
* alerty bezpieczeństwa;
* konfigurację systemu;
* migracje schematu.

Aplikacja po restarcie nie może tracić żadnego istotnego stanu.

# Co dokładnie utrwalamy

## Użytkownicy i tożsamości

```text
users
external_identities
user_status
login_history
authentication_events
mfa_methods
```

Przykład:

```text
użytkownik: jan.kowalski
źródło: OIDC / PAM / LDAP
status: active
ostatnie logowanie
liczba błędnych logowań
data utworzenia
```

Nie musisz przechowywać hasła użytkownika. W przypadku PAM, LDAP lub OIDC przechowujesz tylko powiązanie tożsamości.

## Sesje

```text
sessions
session_events
refresh_tokens
revoked_sessions
```

Sesja powinna zawierać:

```text
session_id
user_id
created_at
last_seen_at
absolute_expires_at
idle_expires_at
client_ip
user_agent
revoked_at
revocation_reason
```

Tokenów sesji nie zapisuj bezpośrednio. W bazie powinien znajdować się ich hash:

```text
SHA-256(token)
```

Dzięki temu wyciek bazy nie daje od razu aktywnych tokenów bearer.

## Role i uprawnienia

```text
roles
permissions
role_permissions
user_roles
host_role_bindings
host_group_role_bindings
```

Przykładowe permission:

```text
host.view
service.view
service.restart
package.install
file.read
file.write
user.create
network.modify
terminal.open
audit.view
host.manage
```

RBAC powinien być granularny. Sama rola `admin/readonly` będzie za mało precyzyjna dla setek użytkowników.

Przykład:

```text
Operator Linux:
- host.view
- service.view
- service.restart
- journal.view

Security Auditor:
- host.view
- audit.view
- inventory.view

Administrator:
- pełny zakres
```

# Hosty

```text
hosts
host_groups
host_group_members
host_tags
host_metadata
host_connection_profiles
ssh_host_keys
host_status_history
```

Host powinien mieć stabilny UUID niezależny od hostname:

```text
id
display_name
hostname
port
connection_method
enabled
created_at
updated_at
last_seen_at
status
environment
```

Przykładowe tagi:

```text
environment=production
location=warsaw
team=payments
os=ubuntu
criticality=high
```

# Klucze hostów SSH

Tenodera musi przechowywać historię kluczy hostów SSH:

```text
ssh_host_keys
ssh_host_key_events
```

Tabela:

```text
host_id
algorithm
fingerprint_sha256
public_key
first_seen_at
last_seen_at
trusted_at
trusted_by
revoked_at
replacement_key_id
```

Zmiana host key nie może zostać automatycznie zaakceptowana.

Powinna generować zdarzenie:

```text
SSH_HOST_KEY_CHANGED
```

i wymagać świadomego zatwierdzenia administratora.

# Operacje i kolejka zadań

Nawet jeśli pierwsza wersja wykonuje operacje interaktywnie, każda z nich powinna zostać zapisana jako trwały job.

```text
jobs
job_targets
job_attempts
job_events
job_results
```

Przykład:

```text
job:
  id: UUID
  actor: jan.kowalski
  operation: service.restart
  host: server-01
  resource: nginx.service
  requested_at: ...
  state: succeeded
```

Cykl życia:

```text
created
authorized
queued
running
succeeded
failed
cancelled
timed_out
```

Dzięki temu restart serwera Tenodera nie usuwa informacji, że operacja była wykonywana.

## Durable queue w PostgreSQL

Na początku nie potrzebujesz osobnego RabbitMQ ani Kafka.

Worker może pobierać zadania przez:

```sql
SELECT *
FROM jobs
WHERE state = 'queued'
ORDER BY created_at
FOR UPDATE SKIP LOCKED
LIMIT 1;
```

To pozwala uruchomić później kilka workerów bez podwójnego wykonania tego samego zadania.

Każdy job powinien mieć:

```text
idempotency_key
deadline
attempt_count
max_attempts
locked_by
locked_at
```

# Wyniki operacji

Utrwalamy:

```text
exit_code
started_at
finished_at
duration
success/failure
error_code
structured_response
stdout metadata
stderr metadata
truncated
```

Nie należy bezrefleksyjnie zapisywać każdej dowolnej ilości stdout do jednej kolumny PostgreSQL.

Dla małych wyników:

```text
JSONB / TEXT w PostgreSQL
```

Dla dużych:

```text
PostgreSQL:
- metadata
- hash
- size
- storage key

Object storage:
- pełny payload
```

Przykładowo:

```text
MinIO
S3
lokalny encrypted object store
```

Jeżeli początkowo nie chcesz wdrażać object storage, możesz ustawić limit:

```text
maksymalnie 1–4 MiB wyniku na operację
```

i oznaczać:

```text
truncated = true
```

# Inventory i stan hostów

```text
inventory_snapshots
inventory_components
packages_snapshot
services_snapshot
network_snapshot
storage_snapshot
security_snapshot
```

Nie wszystko musi być przechowywane jako osobna tabela. Możesz zacząć od:

```sql
inventory_snapshots (
    id UUID,
    host_id UUID,
    snapshot_type TEXT,
    collected_at TIMESTAMPTZ,
    schema_version INTEGER,
    payload JSONB
)
```

Później najczęściej filtrowane dane można znormalizować.

Przykład:

```json
{
  "os": {
    "id": "ubuntu",
    "version": "24.04"
  },
  "kernel": "6.8.0",
  "cpu": {
    "logical_cores": 16
  },
  "memory": {
    "total_bytes": 34359738368
  }
}
```

Każdy snapshot musi mieć `schema_version`, aby dało się rozwijać format bez utraty kompatybilności.

# Audit log

Audit jest jednym z najważniejszych powodów zastosowania PostgreSQL.

```text
audit_events
audit_event_details
security_events
```

Każde zdarzenie powinno zapisywać:

```text
event_id
timestamp
actor_id
actor_identity
session_id
source_ip
host_id
action
resource
decision
result
request_id
job_id
error_code
metadata
```

Przykład:

```json
{
  "action": "service.restart",
  "actor": "jan.kowalski",
  "host": "prod-api-01",
  "resource": "nginx.service",
  "authorization": "allowed",
  "result": "succeeded",
  "duration_ms": 821
}
```

Audit powinien obejmować również nieudane działania:

```text
login_failed
authorization_denied
ssh_host_key_changed
sudo_failed
operation_timed_out
session_revoked
permission_changed
host_deleted
```

## Audit odporny na manipulację

Sam zapis w zwykłej tabeli nie zapewnia niezmienności.

Można zastosować hash chain:

```text
event_hash =
SHA-256(
    previous_hash
    || canonical_event_payload
)
```

Tabela:

```text
previous_hash
event_hash
```

Dodatkowo okresowo podpisywać checkpoint:

```text
ostatni hash dnia
→ podpis minisign lub Ed25519
→ zapis poza bazą
```

Administrator bazy nadal może usunąć rekordy, ale naruszenie łańcucha będzie wykrywalne.

Docelowo warto wspierać eksport do:

```text
syslog
journald
Splunk
Elastic
Loki
SIEM
```

# Konfiguracja i historia zmian

```text
settings
setting_versions
configuration_changes
feature_flags
```

Nie należy aktualizować konfiguracji bez historii.

Przykład:

```text
kto zmienił
co zmienił
poprzednia wartość
nowa wartość
kiedy
z jakiej sesji
```

# Poświadczenia i sekrety

PostgreSQL nie powinien być magazynem plaintext credentials.

## Nie zapisujemy

```text
hasła SSH
hasła sudo
hasła PAM
prywatne efemeryczne klucze użytkowników
jednorazowe bootstrap tokeny w plaintext
```

## Co można zapisywać

```text
hash tokenu
fingerprint klucza
zaszyfrowany sekret integracyjny
metadata klucza
data utworzenia
data rotacji
```

Jeżeli musisz utrwalić sekret, np. OIDC client secret lub klucz integracyjny, użyj envelope encryption:

```text
PostgreSQL:
  ciphertext
  nonce
  key_version

Klucz główny:
  systemd credentials
  Vault
  HSM
  TPM
  zewnętrzny KMS
```

Klucz szyfrujący nie może znajdować się w tej samej bazie co ciphertext.

# Terminal

Terminal wymaga osobnej decyzji dotyczącej retencji.

Możliwe poziomy:

## Metadata only

Zapisujesz:

```text
kto
na jakim hoście
czas otwarcia
czas zamknięcia
exit status
adres klienta
```

Bez treści sesji.

## Command audit

Zapisujesz polecenia, jeżeli shell i środowisko pozwalają je wiarygodnie przechwycić.

## Full recording

Nagrywasz pełny strumień terminala:

```text
stdin
stdout
stderr
resize events
timestamps
```

To jest bardzo wartościowe dla enterprise, ale wiąże się z:

* dużym wolumenem danych;
* możliwością zapisania sekretów;
* obowiązkami prywatności;
* polityką retencji;
* kontrolą dostępu do nagrań.

Dla produktu profesjonalnego zaprojektowałbym możliwość nagrywania, ale domyślnie:

```text
metadata only
```

Pełne nagrywanie powinno być świadomie aktywowane przez administratora organizacji.

# Minimalny model danych

Na początek wystarczy około kilkunastu tabel:

```text
users
external_identities
sessions

roles
permissions
role_permissions
user_roles

hosts
host_groups
host_group_members
ssh_host_keys

jobs
job_attempts
job_results

audit_events
inventory_snapshots
settings
schema_migrations
```

Nie trzeba od razu implementować:

```text
billing
multi-tenancy
approvals
maintenance windows
complex workflows
```

PostgreSQL będzie jednak gotowy na ich późniejsze dodanie.

# Multi-user i multi-tenant

Setki użytkowników nie muszą oznaczać SaaS multi-tenant.

Możesz rozpocząć od jednej organizacji:

```text
single deployment
single organization
many users
many hosts
```

Ale w schemacie warto od początku dodać:

```text
organization_id
```

do głównych tabel:

```text
users
hosts
roles
jobs
audit_events
```

Nawet jeśli początkowo istnieje tylko jedna organizacja:

```text
00000000-0000-0000-0000-000000000001
```

Koszt dodania kolumny teraz jest mały. Późniejsza migracja całego systemu do multi-tenancy będzie znacznie trudniejsza.

Każde zapytanie musi wtedy zawierać:

```sql
WHERE organization_id = $1
```

Dodatkowo możesz później użyć PostgreSQL Row-Level Security.

# Schemat wieloinstancyjny

Przy setkach użytkowników warto od początku założyć możliwość uruchomienia więcej niż jednej instancji servera:

```text
                    ┌──────────────┐
Browser ───────────►│ Load Balancer│
                    └──────┬───────┘
                           │
            ┌──────────────┴──────────────┐
            │                             │
┌───────────▼──────────┐      ┌───────────▼──────────┐
│ Tenodera Server 1    │      │ Tenodera Server 2    │
└───────────┬──────────┘      └───────────┬──────────┘
            │                             │
            └──────────────┬──────────────┘
                           ▼
                     PostgreSQL
```

Dlatego:

* sesje powinny być w PostgreSQL;
* joby powinny być trwałe;
* nie wolno polegać na lokalnej pamięci procesu jako źródle prawdy;
* locking musi być rozproszony;
* requesty muszą mieć idempotency keys;
* migracje schematu muszą być wykonywane kontrolowanie.

Aktywne połączenia SSH nadal należą do konkretnej instancji. W bazie zapisujesz:

```text
connection_owner_instance_id
heartbeat
lease_expires_at
```

Po śmierci instancji lease wygasa i inna instancja może przejąć kolejne zadania.

# PostgreSQL nie może być pojedynczym punktem zaniedbania

Dla produktu sprzedawanego firmom potrzebujesz:

## Backup

```text
regular pg_dump
WAL archiving
point-in-time recovery
encrypted backups
test restore
```

Backup bez regularnego testu odtworzenia nie jest wiarygodnym backupem.

## Migracje

Polecam:

```text
sqlx migrations
```

Każda wersja aplikacji ma przypisany zakres obsługiwanych wersji schematu.

Startup nie powinien automatycznie wykonywać ryzykownej migracji w dużym wdrożeniu bez kontroli.

Możesz użyć:

```bash
tenodera migrate status
tenodera migrate apply
tenodera migrate verify
```

## Connection pooling

Na początek wbudowany pool `sqlx` wystarczy.

Dla wielu instancji można dodać:

```text
PgBouncer
```

ale nie jest potrzebny w pierwszym wydaniu.

# Poprawiona definicja produktu

Tenodera v2:

> **Self-hosted, multi-user Linux administration platform using PostgreSQL for durable control-plane state and native SSH/PAM/sudo for host access.**

Najważniejsze właściwości:

```text
PostgreSQL:
- pełna trwałość
- RBAC
- audit
- historia
- jobs
- inventory

SSH:
- dostęp do hostów
- weryfikacja tożsamości hosta
- brak stale działającego agenta root

PAM/SSSD/OIDC:
- tożsamość użytkownika

sudo/polkit:
- lokalna autoryzacja operacji
```

# Poprawiony zakres Tenodery v2

## W pierwszym komercyjnym wydaniu

* PostgreSQL jako obowiązkowy backend;
* wielu użytkowników;
* RBAC;
* host groups i tags;
* pełny audit;
* historia operacji;
* durable jobs;
* inventory snapshots;
* SSH host key verification;
* SSH bridge;
* systemd;
* procesy;
* journal;
* pakiety;
* pliki;
* użytkownicy;
* terminal;
* podpisane wydania;
* backup/restore;
* migracje.

## Później

* OIDC i SAML;
* MFA;
* SSH CA;
* multi-tenant SaaS;
* HA;
* approval workflows;
* harmonogramy;
* SIEM;
* pełne nagrywanie terminala;
* object storage;
* PostgreSQL RLS;
* Windows.

# Kolejność budowy

## Faza 1 — fundament danych

1. PostgreSQL.
2. Migracje.
3. Użytkownicy i external identities.
4. Sesje.
5. Hosts i host keys.
6. RBAC.
7. Audit.

## Faza 2 — pierwszy pionowy przepływ

```text
login
→ wybór hosta z PostgreSQL
→ sprawdzenie permission
→ SSH
→ bridge
→ service.status
→ zapis job
→ zapis result
→ audit
```

## Faza 3 — mutacja

```text
service.restart
→ authorization
→ job queued
→ execution
→ result
→ audit
```

## Faza 4 — kolejne subsystemy

1. systemd;
2. journal;
3. procesy;
4. pakiety;
5. pliki;
6. użytkownicy;
7. sieć;
8. storage;
9. terminal.

## Faza 5 — produkcyjność

* upgrade;
* rollback;
* backup;
* restore;
* retencja;
* monitoring;
* metryki;
* rate limiting;
* load testing;
* security review;
* pentest.

# Ostateczna decyzja

W Twoim przypadku nie proponowałbym już SQLite.

Przy celu:

```text
setki użytkowników
wielu administratorów
sprzedaż B2B
trwały audit
pełna historia
przyszłe HA
```

właściwa decyzja to:

> **PostgreSQL jako jedyny wspierany backend Tenodery v2.**

Architektura nadal pozostaje stosunkowo prosta:

```text
browser
→ Tenodera Server
→ PostgreSQL
→ SSH
→ bridge
→ sudo
→ Linux
```

PostgreSQL utrwala cały stan control plane, ale hasła i krótkotrwałe sekrety pozostają wyłącznie w pamięci albo w dedykowanym systemie zarządzania sekretami.
