//! RBAC seed (ADR-0006).
//!
//! Permissions ARE the operation namespace (fine keys + coarse groups), so they
//! cannot drift from ADR-0005 operations. This seeds the permission catalogue, the
//! built-in roles, and — for development — two accounts (`admin`, `operator`) with
//! roles, so the permission gate can be exercised end to end. Idempotent.

use sqlx::PgPool;

use crate::auth::DEFAULT_ORG;

/// (key, description). Extend as operations are added (ADR-0005).
const PERMISSIONS: &[(&str, &str)] = &[
    ("host.view", "View hosts"),
    ("host.manage", "Register / edit / remove hosts"),
    ("service.view", "View systemd services"),
    ("service.manage", "Start / stop / restart services"),
    ("journal.view", "Read the journal"),
    ("package.view", "View packages"),
    ("package.manage", "Install / remove / update packages"),
    ("user.view", "View system users"),
    ("user.manage", "Create / modify / delete system users"),
    ("inventory.view", "View host inventory"),
    ("audit.view", "View the audit log"),
];

/// Built-in roles → their permission keys. `Administrator` gets everything.
fn builtin_roles() -> Vec<(&'static str, Vec<&'static str>)> {
    let all: Vec<&str> = PERMISSIONS.iter().map(|(k, _)| *k).collect();
    vec![
        ("Administrator", all),
        (
            "Operator",
            vec![
                "host.view",
                "service.view",
                "service.manage",
                "journal.view",
                "package.view",
                "inventory.view",
            ],
        ),
        (
            "Security Auditor",
            vec!["host.view", "audit.view", "inventory.view"],
        ),
    ]
}

pub async fn seed(pool: &PgPool) -> anyhow::Result<()> {
    // Permissions.
    for (key, desc) in PERMISSIONS {
        sqlx::query(
            "INSERT INTO permissions (key, description) VALUES ($1, $2)
             ON CONFLICT (key) DO NOTHING",
        )
        .bind(key)
        .bind(desc)
        .execute(pool)
        .await?;
    }

    // Roles + their permissions.
    for (role, perms) in builtin_roles() {
        sqlx::query(
            "INSERT INTO roles (id, organization_id, name, builtin)
             VALUES (gen_random_uuid(), ($1)::uuid, $2, true)
             ON CONFLICT (organization_id, name) DO NOTHING",
        )
        .bind(DEFAULT_ORG)
        .bind(role)
        .execute(pool)
        .await?;

        for p in perms {
            sqlx::query(
                "INSERT INTO role_permissions (role_id, permission)
                 SELECT r.id, $3 FROM roles r
                  WHERE r.organization_id = ($1)::uuid AND r.name = $2
                 ON CONFLICT DO NOTHING",
            )
            .bind(DEFAULT_ORG)
            .bind(role)
            .bind(p)
            .execute(pool)
            .await?;
        }
    }

    // Dev accounts + role grants (for exercising the gate; real enrollment later).
    ensure_dev_user(pool, "admin", "Administrator").await?;
    ensure_dev_user(pool, "operator", "Operator").await?;
    Ok(())
}

async fn ensure_dev_user(pool: &PgPool, username: &str, role: &str) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO users (id, organization_id, username, local_principal)
         VALUES (gen_random_uuid(), ($1)::uuid, $2, $2)
         ON CONFLICT (organization_id, username) DO NOTHING",
    )
    .bind(DEFAULT_ORG)
    .bind(username)
    .execute(pool)
    .await?;

    // Grant the role once (idempotent via NOT EXISTS).
    sqlx::query(
        "INSERT INTO user_roles (id, user_id, role_id, scope_kind)
         SELECT gen_random_uuid(), u.id, r.id, 'global'
           FROM users u, roles r
          WHERE u.organization_id = ($1)::uuid AND u.username = $2
            AND r.organization_id = ($1)::uuid AND r.name = $3
            AND NOT EXISTS (
                SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_id = r.id
            )",
    )
    .bind(DEFAULT_ORG)
    .bind(username)
    .bind(role)
    .execute(pool)
    .await?;
    Ok(())
}
