# A GNU/Linux SSH target, so the end-to-end matrix covers a Debian userland as
# well as the Alpine one in sshd.Dockerfile. The two differ in what the remote
# scripts may assume: `stat -c` and `realpath` are present here, while Alpine
# exercises the lighter busybox-adjacent path.
#
#   docker build -f test/docker/sshd-debian.Dockerfile \
#     --build-arg AUTHORIZED_KEY="$(cat /tmp/id_test.pub)" -t dsh-remote-ssh-test-debian .
FROM debian:12-slim

RUN apt-get update \
 && apt-get install --no-install-recommends --yes openssh-server bash ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --shell /bin/bash dsh \
 && echo 'dsh:remote-ssh-test-only' | chpasswd \
 && mkdir -p /home/dsh/.ssh /home/dsh/work/repo /run/sshd

ARG AUTHORIZED_KEY
RUN printf '%s\n' "${AUTHORIZED_KEY}" > /home/dsh/.ssh/authorized_keys \
 && chown -R dsh:dsh /home/dsh \
 && chmod 700 /home/dsh/.ssh \
 && chmod 600 /home/dsh/.ssh/authorized_keys \
 && ssh-keygen -A \
 && printf 'PasswordAuthentication no\nPermitRootLogin no\nLogLevel VERBOSE\n' >> /etc/ssh/sshd_config \
 && printf 'Bienvenue sur le serveur de test\n' > /home/dsh/work/repo/README.md \
 && chown -R dsh:dsh /home/dsh/work

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e", "-p", "22"]
