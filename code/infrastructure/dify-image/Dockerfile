# syntax=docker/dockerfile:1
# Local build only. Runtime qualification is enforced by the behavioral tests.
FROM langgenius/dify-sandbox:0.2.15@sha256:942acde5b90350498f71c9f89fe1c0a578578c51521d6683783e073528b6a26a AS sandbox-upstream
FROM langgenius/dify-api:1.19.0@sha256:9ba04a262dded58dd0237857aefae3f70a6796588fff7a2b1ff0b0eaa91a2949 AS api-upstream
FROM langgenius/dify-web:1.19.0@sha256:6b3f4f47a85d74865983163438661dc4f9d01bd4aeb93fdecae81225eab77f23 AS web-upstream
FROM langgenius/dify-plugin-daemon:0.6.14-local@sha256:1fb555e231e318c9fb25f9eb67d301ecbb247e1e8835ba7b1827a23d405af448 AS plugin-upstream
FROM langgenius/dify-agent-local-sandbox:1.19.0@sha256:8b3a355f18b9660fdc9a709f7368370f01cb02c800e234b659f1803b3368900e AS shellctl-upstream

FROM golang:1.24.11-bookworm@sha256:48598621657fe214b140f059f9e53b36f506d4dbc6ad3ef79aed1af590706425 AS sandbox-build
RUN apt-get update && apt-get install -y --no-install-recommends libseccomp-dev python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ADD https://codeload.github.com/langgenius/dify-sandbox/tar.gz/5631afef06ec88f80c28129aec7fd22a30006b14 /tmp/source.tar.gz
WORKDIR /src
RUN tar --strip-components=1 -xf /tmp/source.tar.gz && rm /tmp/source.tar.gz
COPY sandbox/harden.py /tmp/harden.py
RUN python3 /tmp/harden.py /src
COPY sandbox/output_capture.go /src/internal/core/runner/output_capture.go
RUN gofmt -w internal/core/runner/output_capture.go \
    && go build -buildmode=c-shared -o internal/core/runner/python/python.so ./cmd/lib/python \
    && go build -buildmode=c-shared -o internal/core/runner/nodejs/nodejs.so ./cmd/lib/nodejs \
    && go build -o /out/main ./cmd/server

FROM langgenius/dify-agent-backend:1.19.0@sha256:cb77b3841acced310d3f242998ecef41751fe34d3c9c90689d7628130d1cf14e AS system-deps
USER root
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql-17=17.11-0+deb13u1 postgresql-17-pgvector=0.8.0-1 \
    redis-server=5:8.0.2-3+deb13u3 nginx squid openssh-server tini \
    libmagic1 libseccomp2 libcap2-bin curl xz-utils git openssl ca-certificates tmux \
    && rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub \
    && rm -f /etc/ssl/private/ssl-cert-snakeoil.key /etc/ssl/certs/ssl-cert-snakeoil.pem \
    && rm -rf /var/lib/apt/lists/*

# Keep Debian's exact security patchset, but do not require host-kernel audit
# privileges for PTY login. This is an explicit disabled backend, not fake audit.
FROM system-deps AS sshd-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential autoconf automake pkgconf libssl-dev zlib1g-dev \
    libpam0g-dev libselinux1-dev libwtmpdb-dev libedit-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
ADD https://deb.debian.org/debian/pool/main/o/openssh/openssh_10.0p1.orig.tar.gz /tmp/original.tar.gz
ADD https://deb.debian.org/debian/pool/main/o/openssh/openssh_10.0p1-7+deb13u4.debian.tar.xz /tmp/debian.tar.xz
RUN python3 -c "import hashlib; from pathlib import Path; assert hashlib.sha256(Path('/tmp/original.tar.gz').read_bytes()).hexdigest() == '021a2e709a0edf4250b1256bd5a9e500411a90dddabea830ed59cef90eb9d85c'; assert hashlib.sha256(Path('/tmp/debian.tar.xz').read_bytes()).hexdigest() == '102e1065030c6002acabd7f896eeba1462bf54b4d7393bac34b0308312868ec6'" \
    && tar -xf /tmp/original.tar.gz --strip-components=1 && tar -xf /tmp/debian.tar.xz
RUN python3 -c "import subprocess,shlex; from pathlib import Path; p=Path('debian/patches'); [subprocess.run(['patch','-p1','--batch','--forward','-i',str(p/shlex.split(line)[0]),*shlex.split(line)[1:]],check=True) for line in (p/'series').read_text().splitlines() if line.strip() and not line.lstrip().startswith('#')]"
RUN autoreconf -fi && ./configure --enable-option-checking=fatal \
    --prefix=/usr --sysconfdir=/etc/ssh \
    --libexecdir=/usr/lib/openssh --with-privsep-path=/run/sshd \
    --with-default-path=/usr/local/bin:/usr/bin:/bin:/usr/games \
    --with-superuser-path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    --with-privsep-user=sshd --with-pam --with-selinux --without-audit \
    && make -j4 sshd sshd-session sshd-auth \
    && ! grep -Eq '^#define (USE_LINUX_AUDIT|USE_BSM_AUDIT|SSH_AUDIT_EVENTS) 1' config.h \
    && grep -q '^#define USE_PAM 1' config.h \
    && grep -q '^#define WITH_SELINUX 1' config.h

# Qualification target: only the hardened code sandbox, not the all-in-one image.
FROM system-deps AS sandbox-runtime
COPY --from=sandbox-upstream /opt/python /opt/python
COPY --from=sandbox-upstream /opt/node-v20.20.0-linux-x64.tar.xz /tmp/sandbox-node.tar.xz
RUN mkdir -p /opt/dify-sandbox /dependencies /var/sandbox/sandbox-python/tmp \
    && tar --no-same-owner -xf /tmp/sandbox-node.tar.xz -C /opt/dify-sandbox \
    && rm /tmp/sandbox-node.tar.xz
COPY --from=sandbox-upstream /dependencies /dependencies
COPY --from=sandbox-upstream /conf /conf
COPY --from=sandbox-build /out/main /opt/dify-sandbox/main
COPY --from=sandbox-build /src/LICENSE /usr/local/share/dify-sandbox/LICENSE
COPY sandbox/kill_job.py /usr/local/lib/dify-image/kill_job.py
COPY sandbox/start.py /usr/local/lib/dify-image/start.py
ENV NODEJS_PATH=/opt/dify-sandbox/node-v20.20.0-linux-x64/bin/node \
    PYTHON_PATH=/opt/python/bin/python3 ENABLE_PRELOAD=false GIN_MODE=release
WORKDIR /
ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/python3","/usr/local/lib/dify-image/start.py"]

# One final filesystem, with native processes only; there is no inner Docker daemon.
FROM sandbox-runtime AS runtime
USER root
RUN mv /app/api /opt/agent
COPY --from=api-upstream /app/api /app/api
COPY --from=api-upstream /entrypoint.sh /opt/dify-image/api-entrypoint.sh
COPY --from=web-upstream /app/targets/next /opt/web
COPY --from=plugin-upstream /app/main /opt/plugin/main
COPY --from=plugin-upstream /app/commandline /opt/plugin/commandline
COPY --from=shellctl-upstream /usr/local/bin/shellctl /usr/local/bin/shellctl
COPY --from=shellctl-upstream /usr/local/bin/shellctl-sanitize-pty /usr/local/bin/shellctl-sanitize-pty
COPY --from=shellctl-upstream /usr/local/bin/shellctl-runner-exit /usr/local/bin/shellctl-runner-exit
ADD https://codeload.github.com/langgenius/dify/tar.gz/8e689e868b63b6dd2b449d0eb568ca5cc7127759 /tmp/dify.tar.gz
RUN mkdir -p /opt/upstream && tar -xzf /tmp/dify.tar.gz -C /opt/upstream --strip-components=1 \
      --wildcards '*/docker/envs/*' '*/docker/nginx/*' '*/docker/ssrf_proxy/*' \
    && rm /tmp/dify.tar.gz \
    && curl -fsSLo /tmp/node.tar.xz https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz \
    && curl -fsSLo /tmp/SHASUMS256.txt https://nodejs.org/dist/v24.22.1/SHASUMS256.txt \
    && cd /tmp && grep ' node-v24.22.1-linux-x64.tar.xz$' SHASUMS256.txt | sed 's/node-v24.22.1-linux-x64.tar.xz/node.tar.xz/' | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz /tmp/SHASUMS256.txt \
    && npm install -g npm@11.19.1 @github/copilot@1.0.106 \
    && npm install --prefix /opt/sharp sharp@0.35.5 \
    && mkdir -p /opt/nvm \
    && curl -fsSL https://github.com/nvm-sh/nvm/archive/refs/tags/v0.41.0.tar.gz | tar -xz --strip-components=1 -C /opt/nvm \
    && mkdir -p /opt/nvm/versions/node/v24.22.1 \
    && ln -s /usr/local/bin /opt/nvm/versions/node/v24.22.1/bin \
    && ln -s /usr/local/lib /opt/nvm/versions/node/v24.22.1/lib \
    && npm cache clean --force
COPY runtime/common.py runtime/build_setup.py /opt/dify-image/runtime/
RUN python /opt/dify-image/runtime/build_setup.py \
    && mkdir -p /run/sshd /data \
    && rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub
COPY runtime/ /opt/dify-image/runtime/
COPY runtime/sandbox_sitecustomize.py /opt/python/lib/python3.14/site-packages/sitecustomize.py
RUN chmod 0755 /opt/dify-image/runtime/shell_runner.py \
    && ln -sf /opt/dify-image/runtime/shell_runner.py /usr/local/bin/shellctl-runner
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /opt/dify-image/runtime
COPY --from=sshd-build /src/sshd /usr/sbin/sshd
COPY --from=sshd-build /src/sshd-session /usr/lib/openssh/sshd-session
COPY --from=sshd-build /src/sshd-auth /usr/lib/openssh/sshd-auth
EXPOSE 80 22
HEALTHCHECK --interval=10s --timeout=5s --start-period=300s CMD ["/usr/local/bin/python3","/opt/dify-image/runtime/probes.py"]
ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/python3","/opt/dify-image/runtime/supervisor.py"]
