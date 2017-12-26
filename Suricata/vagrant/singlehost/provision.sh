check_service(){
  systemctl daemon-reload
  systemctl is-enabled $1.service 2>/dev/null | grep "disabled" && systemctl enable $1.service
  systemctl status $1.service | egrep  "inactive" && systemctl start $1.service
  systemctl status $1.service
}

# params
DEBUG=true
PROXY=http://192.168.10.1:3128
PKGDIR=/vagrant/pkgs
WGET_PARAMS="-4 -q"

# versions
ELA="elasticsearch-6.0.1.deb"
# 6.1.1 index management was broken for me
KIBANA="kibana-6.0.1-amd64.deb"
LOGSTASH="logstash-6.0.1.deb"
INFLUX="influxdb_1.4.2_amd64.deb"
TELEGRAF="telegraf_1.5.0-1_amd64.deb"
GRAFANA="grafana_4.6.3_amd64.deb"
SCIRIUS="scirius_1.2.7-1_amd64.deb"

# basic OS config
start=$(date)

FILE=/etc/sysctl.conf
grep "disable_ipv6" $FILE || cat >> $FILE <<EOF
net.ipv6.conf.all.disable_ipv6 = 1
net.ipv6.conf.default.disable_ipv6 = 1
net.ipv6.conf.lo.disable_ipv6 = 1
EOF
sysctl -p

#FILE=/etc/profile
#grep "proxy" $FILE || cat >> $FILE <<EOF
#http_proxy=$PROXY
#https_proxy=$PROXY
#export http_proxy
#export https_proxy
#EOF
#source /etc/profile

FILE=/etc/apt/apt.conf.d/99force-ipv4
[[ -f $FILE ]] ||  echo 'Acquire::ForceIPv4 "true";' | sudo tee $FILE
export DEBIAN_FRONTEND=noninteractive
mkdir -p /vagrant/pkgs

# basic software
#apt-get update > /dev/null && apt-get install curl htop vim tmux > /dev/null

# suricata
install_suricata_from_ppa(){
  add-apt-repository ppa:oisf/suricata-stable > /dev/null 2>&1 \
  && apt-get update > /dev/null \
  && apt-get install -y suricata > /dev/null
}
echo "Provisioning SURICATA"
suricata -V || install_suricata_from_ppa

[[ -f /etc/suricata/rules/scirius.rules ]] || touch /etc/suricata/rules/scirius.rules
if $DEBUG ; then ip addr show; fi
systemctl stop suricata
FILE=/etc/suricata/suricata.yaml
grep "Amstelredamme" $FILE || cat >> $FILE <<EOF
# Amstelredamme added by vagrant
af-packet:
  - interface: enp0s3
    cluster-id: 98
    cluster-type: cluster_flow
    defrag: yes
  - interface: enp0s8
    cluster-id: 97
    cluster-type: cluster_flow
    defrag: yes
  - interface: eth0
    cluster-id: 96
    cluster-type: cluster_flow
    defrag: yes
  - interface: eth1
    cluster-id: 95
    cluster-type: cluster_flow
    defrag: yes
default-rule-path: /etc/suricata/rules
rule-files:
 - scirius.rules
sensor-name: suricata
EOF

touch  /etc/suricata/threshold.config
if $DEBUG ; then suricata -T -vvv; fi

check_service suricata

# java
install_oracle_java() {
  echo "Installing oracle Java"
  echo 'oracle-java8-installer shared/accepted-oracle-license-v1-1 boolean true' | debconf-set-selections \
  && add-apt-repository ppa:webupd8team/java > /dev/null 2>&1 \
  && apt-get update > /dev/null \
  && apt-get -y install oracle-java8-installer > /dev/null
}
echo "Provisioning JAVA"
java -version || install_oracle_java

# elastic
echo "Provisioning ELASTICSEARCH"
cd $PKGDIR
[[ -f $ELA ]] || wget $WGET_PARAMS https://artifacts.elastic.co/downloads/elasticsearch/$ELA -O $ELA
dpkg -i $ELA > /dev/null 2>&1

check_service elasticsearch

# kibana
echo "Provisioning KIBANA"
cd $PKGDIR
[[ -f $KIBANA ]] || wget $WGET_PARAMS https://artifacts.elastic.co/downloads/kibana/$KIBANA -O $KIBANA
dpkg -i $KIBANA > /dev/null 2>&1

FILE=/etc/kibana/kibana.yml
grep "provisioned" $FILE || cat >> $FILE <<EOF
# provisioned
server.host: "0.0.0.0"
EOF

check_service kibana

# set up default index pattern
#sleep 5
#curl -ss -XPUT localhost:9200/.kibana/doc/index-pattern:a1571060-e8e2-11e7-9cf4-db76e233e72b -d @/vagrant/kibana-index-pattern.json -H'Content-Type: application/json'
#curl -ss -XPUT localhost:9200/.kibana/doc/config:6.0.1 -d @/vagrant/kibana-index-pattern-config.json -H'Content-Type: application/json'

# logstash
echo "Provisioning LOGSTASH"
cd $PKGDIR
[[ -f $LOGSTASH ]] || wget $WGET_PARAMS https://artifacts.elastic.co/downloads/logstash/$LOGSTASH -O $LOGSTASH
dpkg -i $LOGSTASH > /dev/null 2>&1

FILE=/etc/logstash/conf.d/suricata.conf
grep "Amstelredamme" $FILE || cat >> $FILE <<EOF
input {
  file {
    path => "/var/log/suricata/eve.json"
    tags => ["suricata","Amstelredamme"]
  }
}
filter {
  json {
    source => "message"
  }
  if 'syslog' not in [tags] {
    mutate { remove_field => [ "message", "Hostname" ] }
  }
}
output {
  elasticsearch {
    hosts => ["localhost"]
    index => "suricata-%{+YYYY.MM.dd.hh}"
  }
}
EOF
curl -ss -XPUT localhost:9200/_template/default -d @/vagrant/elastic-default-template.json -H'Content-Type: application/json'
chown root:logstash /var/log/suricata/eve.json
check_service logstash

# influx
echo "Provisioning INFLUXDB"
cd $PKGDIR
[[ -f $INFLUX ]] || wget $WGET_PARAMS https://dl.influxdata.com/influxdb/releases/$INFLUX -O $INFLUX
dpkg -i $INFLUX > /dev/null 2>&1
systemctl stop influxdb.service
check_service influxdb

# grafana
echo "Provisioning GRAFANA"
cd $PKGDIR
[[ -f $GRAFANA ]] || wget $WGET_PARAMS https://s3-us-west-2.amazonaws.com/grafana-releases/release/$GRAFANA -O $GRAFANA
apt-get -y install libfontconfig > /dev/null 2>&1
dpkg -i $GRAFANA #> /dev/null 2>&1
systemctl stop grafana-server.service
check_service grafana-server

sleep 1
curl -s -XPOST --user admin:admin 192.168.10.11:3000/api/datasources -H "Content-Type: application/json" -d '{
    "name": "telegraf",
    "type": "influxdb",
    "access": "proxy",
    "url": "http://localhost:8086",
    "database": "telegraf",
    "isDefault": true
}'

# telegraf
echo "Provisioning TELEGRAF"
cd $PKGDIR
[[ -f $TELEGRAF ]] || wget $WGET_PARAMS https://dl.influxdata.com/telegraf/releases/$TELEGRAF -O $TELEGRAF
dpkg -i $TELEGRAF > /dev/null 2>&1

systemctl stop telegraf.service
FILE=/etc/telegraf/telegraf.conf
grep "Amstelredamme" $FILE || cat > $FILE <<EOF
[global_tags]
  year = "2018"

[agent]
  hostname = "Amstelredamme"
  omit_hostname = false
  interval = "1s"
  round_interval = true
  metric_buffer_limit = 1000
  flush_buffer_when_full = true
  collection_jitter = "0s"
  flush_interval = "60s"
  flush_jitter = "10s"
  debug = false
  quiet = true

[[outputs.influxdb]]
  database  = "telegraf"
  urls  = ["http://localhost:8086"]

[[inputs.cpu]]
  percpu = true
  totalcpu = true
[[inputs.disk]]
  ignore_fs = ["tmpfs", "devtmpfs"]
[[inputs.diskio]]
[[inputs.kernel]]
[[inputs.mem]]
[[inputs.net]]
[[inputs.netstat]]
[[inputs.processes]]
[[inputs.swap]]
[[inputs.system]]
EOF

check_service telegraf

# scirius
echo "Provisioning SCIRIUS"
cd $PKGDIR
[[ -f $SCIRIUS ]] || wget $WGET_PARAMS http://packages.stamus-networks.com/selks4/debian/pool/main/s/scirius/$SCIRIUS -O $SCIRIUS
#dpkg -i $SCIRIUS || apt-get -y -f install #> /dev/null 2>&1
apt-get install -y python-pip dbconfig-common sqlite3 python-daemon python-pyinotify > /dev/null && dpkg -i $SCIRIUS
echo 'ELASTICSEARCH_LOGSTASH_INDEX = "suricata-"' >> /etc/scirius/local_settings.py
echo 'ELASTICSEARCH_LOGSTASH_ALERT_INDEX = "suricata-"' >> /etc/scirius/local_settings.py
echo "ELASTICSEARCH_VERSION = 5" >> /etc/scirius/local_settings.py
echo "ELASTICSEARCH_KEYWORD = 'keyword'" >> /etc/scirius/local_settings.py

# adding sources to rulesets
source /usr/share/python/scirius/bin/activate
pip install --upgrade urllib3 > /dev/null
python /usr/share/python/scirius/bin/manage.py addsource "ETOpen Ruleset" https://rules.emergingthreats.net/open/suricata-3.0/emerging.rules.tar.gz http sigs
python /usr/share/python/scirius/bin/manage.py addsource "PT Research Ruleset" https://github.com/ptresearch/AttackDetection/raw/master/pt.rules.tar.gz http sigs
python /usr/share/python/scirius/bin/manage.py defaultruleset "CDMCS ruleset"
python /usr/share/python/scirius/bin/manage.py addsuricata suricata "Suricata on CDMCS" /etc/suricata/rules "CDMCS ruleset"
python /usr/share/python/scirius/bin/manage.py updatesuricata
deactivate
#systemctl stop influxdb.service
#check_service influxdb

#cd /opt
#apt-get install -y git python-pip python-dev > /dev/null
#[[ -d /opt/scirius ]] || git clone https://github.com/StamusNetworks/scirius.git /opt/scirius
#cd /opt/scirius
#git checkout tags/$SCIRIUS > /dev/null 2>&1
#pip install -r requirements.txt > /dev/null 2>&1
#pip install pyinotify > /dev/null 2>&1
#pip install gitdb > /dev/null 2>&1