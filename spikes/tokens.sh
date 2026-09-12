# Source this to get PRODUCER_TOKEN / GRANTOR_TOKEN in the shell.
tok() { python3 -c "
import sys
print([l.strip() for l in open(sys.argv[1]) if l.strip() and not l.startswith('#')][0])" "$1"; }
export PRODUCER_TOKEN=$(tok ~/.dkg-mandate-producer/auth.token)
export GRANTOR_TOKEN=$(tok ~/.dkg-mandate-grantor/auth.token)
export PRODUCER=http://127.0.0.1:9202
export GRANTOR=http://127.0.0.1:9201
