
/* Copyright (c) 2017 Hillar Aarelaid
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 *
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED ``AS IS'' AND ANY EXPRESS OR IMPLIED
 * WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY DIRECT,
 * INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
 * HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT,
 * STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING
 * IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

 /*

# wise source plugin to queri evebox API ver 1 for suricata alerts

* wise :: https://github.com/aol/moloch/tree/master/capture/plugins/wiseService
* evebox :: https://github.com/jasonish/evebox https://evebox.org/

## wise.ini
[suricata]
evBox=https://evebox.blah
fields=sid;severity;signature;category;host;in_iface;flow_id;
### optional tags
mustHaveTags=escalated
mustNotHaveTags=archived;deleted;

*/

'use strict';

// helper stuffff

var flatten = function(data) {
    var result = {};
    function recurse (cur, prop) {
        if (Object(cur) !== cur) {
            result[prop] = cur;
        } else if (Array.isArray(cur)) {
             for(var i=0, l=cur.length; i<l; i++)
                 recurse(cur[i], prop ? prop+"."+i : ""+i);
            if (l == 0)
                result[prop] = [];
        } else {
            var isEmpty = true;
            for (var p in cur) {
                isEmpty = false;
                recurse(cur[p], prop ? prop+"."+p : p);
            }
            if (isEmpty)
                result[prop] = {};
        }
    }
    recurse(data, "");
    return result;
}


// SuricataSource

var wiseSource     = require('./wiseSource.js')
  , util           = require('util')
  , request        = require('request')
  ;

var source;

function SuricataSource (api, section) {
  var self = this;
  SuricataSource.super_.call(this, api, section);
  this.count = 0;
  this.alerts = 0;
  this.errors = 0;
  this.evBox = this.api.getConfig("suricata", "evBox");
  if (this.evBox === undefined) {
    console.log(this.section, "- No evebox host defined; in wise.ini in section [suricata] set evBox=http://localhost:5636");
    return;
  }
  // prepare for field list
  this.fields = [];
  var allowedFields = ['signature_id','severity','signature','category','host','in_iface','flow_id','_id','_index'];
  var fieldDeclas = [];
  fieldDeclas['signature_id'] = "field:suricata.signature_id;db:suricata.signature_id-term;kind:integer;friendly:SID;help:Suricata Signature ID;count:false";
  fieldDeclas['signature']    = "field:suricata.signature;db:suricata.signature-term;kind:termfield;friendly:Signature;help:Suricata Alert Signature;count:false";
  fieldDeclas['category'] = "field:suricata.category;db:suricata.category-term;kind:termfield;friendly:Category;help:Suricata Alert Category;count:false";
  fieldDeclas['severity'] = "field:suricata.severity;db:suricata.severity-term;kind:integer;friendly:Severity;help:Suricata Alert Severity;count:false";
  fieldDeclas['host'] = "field:suricata.host;db:suricata.host-term;kind:termfield;friendly:Host;help:Suricata Host;count:false";
  fieldDeclas['in_iface'] = "field:suricata.in_iface;db:suricata.in_iface-term;kind:termfield;friendly:Iface;help:Suricata in iface;count:false";
  fieldDeclas['_id'] = "field:suricata._id;db:suricata._id-term;kind:termfield;friendly:_id;help:Evebox _id;count:false";
  fieldDeclas['_index'] = "field:suricata._index;db:suricata._index-term;kind:termfield;friendly:_index;help:Evebox index;count:false";
  fieldDeclas['flow_id'] = "field:suricata.flow_id;db:suricata.flow_id-term;kind:termfield;friendly:flow_id;help:Suricata flow id;count:false";
  this.flattNames = [];
  this.flattNames['signature_id'] = 'event._source.alert.signature_id';
  this.flattNames['signature'] = 'event._source.alert.signature';
  this.flattNames['category'] = 'event._source.alert.category';
  this.flattNames['severity'] = 'event._source.alert.severity';
  this.flattNames['host'] = 'event._source.host';
  this.flattNames['in_iface'] = 'event._source.in_iface';
  this.flattNames['_id'] = 'event._id';
  this.flattNames['_index'] = 'event._index';
  this.flattNames['flow_id'] = 'event._source.flow_id';
  // get list of fields
  var fields = this.api.getConfig("suricata", "fields");
  if (fields === undefined) {
    console.log(this.section, "- No fields defined; in wise.ini in section [suricata] set fields=severity;signature;category;");
    return;
  } else {
    fields.split(";").some(function(fieldname){
      if (allowedFields.indexOf(fieldname) == -1){
        console.log(self.section, "-",fieldname,"is not allowed; try one of:", allowedFields.join(";"));
        return true;
      } else {
        if (self.fields.indexOf(fieldname) == -1){
          self.fields.push(fieldname);
        }
      }
    });
    if (this.fields.length < 1) {
      console.log(this.section, "- how you did that !?", fields)
      return;
    } else {
      console.log(this.section, "- using fields", this.fields.join(","));
    }
  }

  this.tags = "";
  // see https://github.com/jasonish/evebox/blob/dbfa3ce1348fc8186bf36fbfda85a7966949e833/webapp/src/app/elasticsearch.service.ts#L288
  var mustHaveTags = this.api.getConfig("suricata", "mustHaveTags");
  if (!this.mustHaveTags === undefined) {
    mustHaveTags.split(";").forEach(function(tag){
      self.tags += tag.trim() + ","
    });
  }
  var mustNotHaveTags = this.api.getConfig("suricata", "mustNotHaveTags");
  if (!mustNotHaveTags === undefined) {
    mustNotHaveTags.split(";").forEach(function(tag){
      self.tags += "-" +tag.trim() + ","
    });
  }
  // test evebox connection
  var options = {
    url: this.evBox+"/api/1/version",
    method: 'GET',
    json: true
  };
  var req = request(options, function(err, im, results) {
    if (err || im.statusCode != 200 || results === undefined) {
      console.log(self.section, "- Error for request:\n", options, "\n", im, "\nresults:\n", results);
      return;
    }
    console.log(self.evBox,"/api/1/version returned",results)
    // TODO move it to https://github.com/aol/moloch/blob/master/capture/plugins/wiseService/wiseSource.js#L39
    self.excludeTuples = [];
    self.api.addSource("suricata", self);
    var str =
      "if (session.suricata)\n" +
      "  div.sessionDetailMeta.bold Suricata \n" +
      "  dl.sessionDetailMeta\n" ;
    self.fields.forEach(function(fieldname){
      self[fieldname+'Field'] = self.api.addField(fieldDeclas[fieldname]);
      if (fieldname === "_id" ) {
        // http://192.168.10.11:5636/#/event/c1b9cd27-1659-11e7-b1f9-02ed55e681b9
          self.api.addRightClick("EveBoxEventLink", {name:"EveBox EVENT", url:self.evBox+"/#/event/%TEXT%", fields:"suricata._id"});
      }
      if (fieldname === "flow_id") {
        //http://192.168.10.11:5636/#/events;q=flow_id%3A%221741428037472661%22
        self.api.addRightClick("EveBoxFlowLink", {name:"EveBox FLOW", url:self.evBox+"/#/events;q=flow_id%3A%22%TEXT%%22", fields:"suricata.flow_id"});
      }
      str += "    +arrayList(session.suricata, '" + fieldname + "-term', '" + fieldname + "', 'suricata." + fieldname + "')\n";
    });
    self.api.addView("suricata", str);
    // print stats
    console.dir(self.api);
    if (self.api.debug>0){
      setInterval(function(){
        console.log("Suricata: checks:",self.count,"alerts:", self.alerts, "query errors:", self.errors);
      }, 60*1000/self.api.debug);
    }
  }).on('error', function (err) {
    console.log(self.section, "- ERROR",err);
    return;
  });
}

util.inherits(SuricataSource, wiseSource);

SuricataSource.prototype.getTuple = function(tuple, cb) {

  this.count += 1;
  // [ '1490640063', 'tcp', '10.0.2.2', '57000', '10.0.2.15', '22' ]
  // wait for node upgrade ...
  // var [ timestamp, protos, src_ip, src_port, dest_ip, dest_port ] = tuple.split(";");
  var bites = tuple.split(";");
  var timestamp = bites[0];
  //var protos = bites[1].split(",");
  var src_ip = bites[2];
  var src_port = bites[3];
  var dest_ip = bites[4];
  var dest_port = bites[5];

  // build evebox query
  // see :
  // * http://evebox.readthedocs.io/en/latest/api.html#get-api-1-alerts
  // * https://github.com/jasonish/evebox/blob/master/elasticsearch/alertqueryservice.go
  // * https://github.com/jasonish/evebox/blob/59472e3dd9449b95bf78dc08e2b7f1a88834ed70/core/eventservice.go#L46
  // for minTs and maxTs see https://github.com/jasonish/evebox/commit/ef993eb87167b3a4184450719f3543ddc7f35b33

  //var timeRange = Math.floor(Date.now()/1000) - timestamp;
  var start = new Date(timestamp * 1000);
  var minTs = start.toISOString();
  // TODO somehow find out session length or session timeout
  var end = new Date((timestamp + 90) * 1000);
  var maxTs = end.toISOString();
  // moloch and suricata sometimes do set "oposite" src and dest
  // so we need query (src and dest) or (dest and src)
  var queryString = "(src_ip:%22"+ src_ip +"%22%20AND%20" +
                    "src_port:%22"+ src_port +"%22%20AND%20" +
                    "dest_ip:%22"+ dest_ip +"%22%20AND%20" +
                    "dest_port:%22"+ dest_port +"%22)OR"+
                    "(src_ip:%22"+ dest_ip +"%22%20AND%20" +
                    "src_port:%22"+ dest_port +"%22%20AND%20" +
                    "dest_ip:%22"+ src_ip +"%22%20AND%20" +
                    "dest_port:%22"+ src_port +"%22)"

  var url = this.evBox+"/api/1/alerts?tags=" +  this.tags +
                                     //"&timeRange=" + timeRange + "s" +
                                     "&min_ts=" + minTs +
                                     "&max_ts=" + maxTs +
                                     "&queryString=" + queryString
  if (this.api.debug > 4) {
    console.log(url)
  }
  var options = {
    url: url,
    method: 'GET',
    json: true
  };
  var self = this;
  var req = request(options, function(err, im, results) {
    if (err || im.statusCode != 200 || results === undefined) {
      this.errors += 1;
      if (self.api.debug > 1) {
      console.log(self.section, "- Error for request:\n", options, "\n", im, "\nresults:\n", results);
      }
      return cb(undefined, undefined);
    }
    self.alerts += 1;
    if (self.api.debug > 3) {
      console.dir(results)
    }
    if (results['alerts'] === undefined || results['alerts'].length == 0) {
      return cb(undefined, undefined);
    } else {
      var args = [];
      results['alerts'].forEach(function(alert){
        alert = flatten(alert);
        self.fields.forEach(function(fieldname){
          args.push(self[fieldname+'Field']);
          args.push(""+alert[self.flattNames[fieldname]]);
        });
      });
      var wiseResult;
      wiseResult = {num: args.length/2, buffer: wiseSource.encode.apply(null, args)};
      return cb(null, wiseResult);
    }
  }).on('error', function (err) {
    console.log(self.section, "- ERROR",err);
    return cb(undefined, undefined);
  });
};

exports.initSource = function(api) {
  var source = new SuricataSource(api, "suricata");
};
