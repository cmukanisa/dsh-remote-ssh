# A minimal, reproducible OpenSSH target for the remote-workspace end-to-end test.
#
# It is deliberately a plain Linux userland with bash, coreutils, and ripgrep, so
# the test exercises the same code paths a real server does: GNU `stat`, GNU
# `realpath`, a login shell, and a remote `rg` for the glob/grep tools.
#
# `chpasswd` is load-bearing: `adduser -D` leaves the account locked (`!` in
# /etc/shadow) and OpenSSH refuses a locked account even for public-key
# authentication, so the password is set and then password login is disabled.
#
#   docker build -f test/docker/sshd.Dockerfile \
#     --build-arg AUTHORIZED_KEY="$(cat /tmp/id_test.pub)" -t dsh-remote-ssh-test .
#   docker run -d --name dsh-ssh-test -p 2222:22 dsh-remote-ssh-test
FROM alpine:3.20

RUN apk add --no-cache openssh bash coreutils grep findutils ripgrep \
 && adduser -D -s /bin/bash dsh \
 && printf 'dsh:remote-ssh-test-only\n' | chpasswd \
 && mkdir -p /home/dsh/.ssh /home/dsh/work/repo

ARG AUTHORIZED_KEY
RUN printf '%s\n' "${AUTHORIZED_KEY}" > /home/dsh/.ssh/authorized_keys \
 && chown -R dsh:dsh /home/dsh \
 && chmod 700 /home/dsh/.ssh \
 && chmod 600 /home/dsh/.ssh/authorized_keys \
 && ssh-keygen -A \
 && printf 'PasswordAuthentication no\nPermitRootLogin no\nLogLevel VERBOSE\n' >> /etc/ssh/sshd_config \
 && printf 'Bienvenue sur le serveur de test\n' > /home/dsh/work/repo/README.md \
 && printf 'export LANG=C.UTF-8\n' >> /etc/profile.d/00-lang.sh \
 && chown -R dsh:dsh /home/dsh/work

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e", "-p", "22"]
