"""Serverless-safe database bootstrap regression tests."""

from contextlib import contextmanager

from adproof import db


def test_postgres_bootstrap_locks_before_schema_ddl(monkeypatch):
    events = []

    class Connection:
        def execute(self, statement, parameters=None):
            events.append((str(statement), parameters))

    class Engine:
        class Dialect:
            name = "postgresql"

        dialect = Dialect()

        @contextmanager
        def begin(self):
            events.append(("begin", None))
            yield Connection()
            events.append(("commit", None))

    monkeypatch.setattr(db, "engine", Engine())
    monkeypatch.setattr(
        db.Base.metadata,
        "create_all",
        lambda connection: events.append(("create_all", connection)),
    )
    monkeypatch.setattr(
        db,
        "_install_immutability_triggers",
        lambda connection: events.append(("install_triggers", connection)),
    )

    db.init_db()

    assert [event[0] for event in events] == [
        "begin",
        "SELECT pg_advisory_xact_lock(:namespace, :resource)",
        "create_all",
        "install_triggers",
        "commit",
    ]
    assert events[1][1] == {
        "namespace": db._SCHEMA_LOCK_NAMESPACE,
        "resource": db._SCHEMA_LOCK_RESOURCE,
    }
