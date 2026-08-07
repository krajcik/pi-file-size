import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { run } from "./run-command.mjs";

const testPath = join(process.cwd(), "tests", "test_pi4_has_auth_for.py");
const source = `from unittest.mock import patch

from requests import Request, Session


def fail_io(*args, **kwargs):
    raise AssertionError("has_auth_for attempted network I/O")


def test_pi4_has_auth_for_tracks_only_most_recent_prepared_host_without_io():
    session = Session()
    session.auth = ("user", "password")
    session.send = fail_io
    with patch("socket.create_connection", side_effect=fail_io), patch(
        "urllib3.util.connection.create_connection", side_effect=fail_io
    ):
        assert session.has_auth_for("https://first.example/resource") is False
        session.prepare_request(Request("GET", "https://first.example/start"))
        assert session.has_auth_for("https://first.example/other") is True
        session.prepare_request(Request("GET", "https://second.example/start"))
        assert session.has_auth_for("https://second.example/other") is True
        assert session.has_auth_for("https://first.example/old") is False
        assert session.has_auth_for("https://other.example/path") is False
        assert session.has_auth_for("not a valid url") is False


def test_pi4_has_auth_for_requires_auth_without_io():
    session = Session()
    session.send = fail_io
    with patch("socket.create_connection", side_effect=fail_io), patch(
        "urllib3.util.connection.create_connection", side_effect=fail_io
    ):
        session.prepare_request(Request("GET", "https://example.com/start"))
        assert session.has_auth_for("https://example.com/other") is False
`;
try {
  await writeFile(testPath, source, { flag: "wx" });
  await run("python3", ["-m", "pytest", testPath]);
} finally {
  await rm(testPath, { force: true });
}
