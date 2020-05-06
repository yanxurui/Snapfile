function updateScroll(){
    var element = document.getElementById("middle");
    element.scrollTop = element.scrollHeight;
}

// js string format
// checkout https://stackoverflow.com/a/18234317/6088837
String.prototype.formatUnicorn = String.prototype.formatUnicorn ||
function () {
    "use strict";
    var str = this.toString();
    if (arguments.length) {
        var t = typeof arguments[0];
        var key;
        var args = ("string" === t || "number" === t) ?
            Array.prototype.slice.call(arguments)
            : arguments[0];

        for (key in args) {
            str = str.replace(new RegExp("\\{" + key + "\\}", "gi"), args[key]);
        }
    }

    return str;
};
// convert date to month-day Hour:Minute
function formatDate(date) {
    var hours = date.getHours();
    var minutes = date.getMinutes();
    hours = hours < 10 ? '0'+hours : hours;
    minutes = minutes < 10 ? '0'+minutes : minutes;
    return (date.getMonth()+1) + "-" + date.getDate() + " " + hours + ":" + minutes;
}

$(function() {
    // =====BEGIN=====Messaging
    var conn = null; // websocket
    var connected = false;
    var err_acc = 0;
    var msg_count = 0;
    var textarea = $('textarea');
    var send = $('input#send_message');

    // display a single message
    function display(msg) {
        var tr = $('<tr>');
        if (msg.type == 0) {
            // TEXT
            // use text instead of html to avoid xss attack
            tr.append($('<td colspan="2">').text(msg.data));
        }
        else if (msg.type == 1) {
            //  FILE
            var a = $('<a target="_blank">').attr('href', '/files/' + msg.file_id + '?name=' + msg.data).text(msg.data);
            tr.append(
                $('<td>').append(a),
                $('<td class="right">').text(msg.size),
            );
        }
        tr.append($('<td>').text(formatDate(new Date(msg.date))));
        $('table').append(tr);
    }

    function connect() {
        disconnect();
        var wsUri = (window.location.protocol == 'https:' && 'wss://' || 'ws://') + window.location.host + '/ws';
        conn = new WebSocket(wsUri);
        conn.onopen = function() {
            connected = true;
            err_acc = 0;
            send.prop("disabled", false);
            console.log('Connected.');
        };
        conn.onmessage = function(e) {
            var data = JSON.parse(e.data);
            console.log('receive');
            switch (data.action) {
                case 'connect':
                    var info = data.info;
                    // new Date from isoformat
                    // format to m-d HH:MM
                    info.expire_at = formatDate(new Date(info.expire_at));
                    update_status(info);
                    conn.send(JSON.stringify({
                        action: 'pull',
                        offset: msg_count
                    }));
                    break;
                case 'send':
                    data.msgs.forEach(msg => display(msg));
                    updateScroll();
                    msg_count += data.msgs.length;
                    break;
            }
        };
        conn.onclose = function(e) {
            conn = null;
            connected = false;
            send.prop("disabled", true);
            console.log('Websocket closed because: (' + e.code + ') ' + e.reason);
            if (e.code == 1006)
            {
                // Abnormal Closure
                // when safari is not in focus
                // ios safari will drop websocket connection due to inactivity
                // and delay any timer until safari comes back to foreground
                console.log('re-connect automatically');
                t = 1000 * Math.pow(2, err_acc);
                if (t < 60 * 1000)
                {
                    setTimeout(connect, t);
                }
            }
            else if (e.code == 4000)
            {
                // Unauthorized (customized)
                window.location = 'login.html';
            }
        };
        conn.onerror = function(e) {
            console.log('Error: ' + JSON.stringify(e));
            err_acc ++;
            // conn.close(); will be called
        };

    }

    function disconnect() {
        if (connected) {
            //log('Disconnecting...');
            conn.close();
        }
    }

    var status_bar_tmpl = $('#status_bar').html();
    function update_status(data) {
        // awesome, it works like a template engine
        $('#status_bar').html(status_bar_tmpl.formatUnicorn(data));
        // the drawback is that event callbacks registered on these dom before will disappear
        // so register them again
        $('#logout').on('click', function() {
            disconnect();
            // $.post('/logout'); does not redirect properly
            // see: https://stackoverflow.com/q/8389646/6088837
            const form = document.createElement('form');
            form.method = 'POST';
            form.action = '/logout';
            document.body.appendChild(form);
            form.submit();
            return false;
        });
    }

    send.on('click', function() {
        var text = textarea.val();
        if (text) {
            console.log('send');
            conn.send(JSON.stringify({
                action: 'send',
                data: text
            }));
            textarea.val('');
            if( ! /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ) {
                textarea.focus(); // bad UE on mobile
            }
        }
        return false;
    });
    
    connect(); // connect immediately
    // ======END======



    // =====BEGIN=====Upload files
    var file_input = $('form#file input');
    var upload_btn = $("input#upload_files");
    var percent = $('.percent');
    var options = {
        beforeSend: function(jqXHR) {
            percent.text('0%');
        },
        uploadProgress: function(event, position, total, percentComplete) {
            percent.text(percentComplete + '%');
        },
        complete: function(xhr, textStatus) {
            // success or error
            percent.text(textStatus + ': ' + xhr.responseText);
        }
    };
    // forward the click event
    upload_btn.click(function () {
        console.log('click upload_btn');
        file_input.trigger('click');
    });
    // listen on select file
    file_input.on('change', function(){
        if (this.value) {
            // submit when the field is not empty
            // i.e., uploading immediately after selecting file(s)
            var form = $("form#file").ajaxSubmit(options);
            // checkout https://stackoverflow.com/questions/12030686/html-input-file-selection-event-not-firing-upon-selecting-the-same-file
            this.value = null;
        }
    });
    // ======END======
});