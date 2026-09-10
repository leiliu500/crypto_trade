"""Change only the already-staged training file target in the local .env.

STAGING_REPORT NEW_CHANGE_REPORT. Does not restart or reset the paper engine.
"""
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
from datetime import datetime, timezone

if len(sys.argv) != 3:
    raise SystemExit("STAGING_REPORT NEW_CHANGE_REPORT required")
stage = json.loads(Path(sys.argv[1]).read_text())
target, previous = stage["target"], stage["previousTrainingFile"]
expected = "/app/data/distributional-training-risk-v2-20260909T201636-" + stage["artifactSha256"][:16] + ".json"
if target != expected or not re.fullmatch(r"[0-9a-f]{64}", stage["artifactSha256"]):
    raise SystemExit("Verified staging target required")
env_path = Path(__file__).resolve().parents[2] / ".env"
metadata = env_path.lstat()
if not stat.S_ISREG(metadata.st_mode):
    raise SystemExit(".env must be a regular file")
original = env_path.read_bytes()
lines = original.decode("utf-8").splitlines(keepends=True)
indexes = [i for i, line in enumerate(lines) if re.match(r"^DISTRIBUTIONAL_TRAINING_FILE\s*=", line)]
if len(indexes) != 1:
    raise SystemExit("Exactly one existing training target required")
i = indexes[0]
value = lines[i].split("=", 1)[1].strip().strip("\"'")
if value != previous:
    raise SystemExit("Training target changed since the runtime capture")
if os.environ.get("DISTRIBUTIONAL_TRAINING_FILE") not in (None, "", target):
    raise SystemExit("Conflicting inherited training target")
newline = "\r\n" if lines[i].endswith("\r\n") else "\n" if lines[i].endswith("\n") else ""
lines[i] = "DISTRIBUTIONAL_TRAINING_FILE=" + target + newline
replacement = "".join(lines).encode("utf-8")
report_path = Path(sys.argv[2])
# Reserve a new evidence file before mutating configuration; never overwrite it.
with report_path.open("x") as report:
    descriptor, temporary = tempfile.mkstemp(prefix=".env.training-target-", dir=env_path.parent)
    try:
        with os.fdopen(descriptor, "wb") as output:
            os.fchmod(output.fileno(), stat.S_IMODE(metadata.st_mode))
            output.write(replacement)
            output.flush()
            os.fsync(output.fileno())
        if env_path.read_bytes() != original:
            raise RuntimeError(".env changed concurrently")
        os.replace(temporary, env_path)
        if env_path.read_bytes() != replacement:
            raise RuntimeError("Training target write verification failed")
        json.dump({"changedAtUtc": datetime.now(timezone.utc).isoformat(),
                   "key": "DISTRIBUTIONAL_TRAINING_FILE", "previous": previous, "target": target,
                   "otherConfigurationBytesPreserved": True, "engineRestartedByScript": False}, report, indent=2)
        report.write("\n")
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
print(json.dumps({"changed": "DISTRIBUTIONAL_TRAINING_FILE", "target": target}))
