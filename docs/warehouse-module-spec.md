# Superatom Data Warehouse Module

## Scope

Implement the data warehouse as a `data-warehouse` module inside the existing Worker.

Do **not** create a separate Worker for the warehouse.

This module should contain only warehouse-specific logic and the abstraction needed by the rest of the system to access warehouse data.

---

## 1. Warehouse Ownership

The warehouse is owned by the **Organization**.

Each organization has its own logical Iceberg warehouse and can have any number of tables with independent schemas.

Projects are **not** separate warehouses.

Physical storage should be organized by organization, for example:

```text
/iceberg-warehouse/<org-id>/...
```

The Iceberg catalog should manage the actual table metadata and storage layout. Do not manually design or depend on a custom Parquet directory structure.

---

## 2. Organization Durable Object

The **Organization DO** is responsible for coordinating the organization's warehouse.

Its warehouse responsibilities are limited to things such as:

- identifying the organization's warehouse
- maintaining warehouse-related configuration/state
- coordinating warehouse operations
- routing warehouse operations through the `data-warehouse` module

Do not put large datasets or query results into Durable Object state. Actual warehouse data belongs in object storage.

---

## 3. Project Durable Object

The **Project DO** controls project-level access to the organization's warehouse.

A project may be granted access to specific tables and/or columns.

Therefore:

```text
Organization
    └── Warehouse
          ├── Table A
          ├── Table B
          └── Table C

Project 1 ──> allowed tables/columns
Project 2 ──> allowed tables/columns
```

Project access is an authorization boundary, not a physical storage boundary.

Do not create separate physical Iceberg warehouses for projects.

---

## 4. Data Source Bridge

The warehouse module must expose a **Data Source Bridge** between the rest of Superatom and the actual warehouse implementation.

The rest of the system should not need to know whether data is stored in Cloudflare or, in the future, locally.

Conceptually:

```text
Superatom
    │
    ▼
Data Source Bridge
    │
    ├── Cloud implementation
    │       └── Basin
    │
    └── Local implementation (future)
            └── Local Iceberg stack
```

The bridge should contain only the warehouse operations actually required by the current system.

Keep this interface small.

The current implementation should provide the Cloud backend.

---

## 5. Cloud Warehouse

The current warehouse implementation uses:

- **Cloudflare R2** for object storage
- **Apache Iceberg** for table/storage format
- **Cloudflare Basin Catalog** for Iceberg catalog/table management
- **Cloudflare Basin SQL** for query execution

Basin provides the managed query execution layer. Do **not** build a distributed query engine inside Superatom.

The architecture should use shared managed Basin infrastructure across organizations. Do not provision a separate query engine or Worker for each organization.

---

## 6. Ingestion

Do not make Basin Streams/Pipelines the core ingestion mechanism.

Existing Worker/DO mechanisms will receive and process incoming data.

The warehouse module should then coordinate writing the resulting data into the organization's Iceberg tables using the configured Iceberg/catalog implementation.

Keep the ingestion implementation independent from the Data Source Bridge's query abstraction.

---

## 7. Query Path

Queries should pass through the Data Source Bridge.

Conceptually:

```text
Superatom
    │
    ▼
Data Source Bridge
    │
    ▼
Cloud Warehouse Adapter
    │
    ▼
Basin SQL
    │
    ▼
Iceberg / R2
```

The bridge/adapter is responsible for selecting and invoking the current warehouse backend.

Do not expose Basin-specific details outside the warehouse module.

---

## 8. Future Local Warehouse

A local/on-premise warehouse is a **future implementation only**.

The design should leave a clean adapter boundary so that a future local backend can use:

- a local Iceberg catalog
- local object storage
- a local query engine

Lakekeeper may be considered as a future Iceberg catalog option, but this is not part of the current implementation.

**Do not implement the local backend now.**

Do not add local infrastructure, dependencies, deployment logic, or configuration unless required solely to keep the adapter boundary clean.

---

## 9. Non-Goals

Do not implement or assume:

- a separate Worker per organization
- a separate physical warehouse per project
- a separate Basin query engine per organization
- a custom distributed query engine
- Basin Streams/Pipelines as the core ingestion system
- the local/on-premise warehouse
- changes to unrelated Superatom engine architecture
- APIs, schemas, or workflows that are not required by this module

The implementation should stay limited to the warehouse module, its Organization DO integration, Project DO access boundary, and Data Source Bridge.
