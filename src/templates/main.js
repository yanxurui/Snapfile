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


$(function() {
    // =====BEGIN=====Messaging
    var conn = null; // websocket
    var err_acc = 0;
    var msg_count = 0;

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
            tr.append(
                $('<td>').text(msg.data),
                $('<td class="right">').text(msg.size),
            );
        }
        tr.append($('<td>').text(msg.date));
        $('table').append(tr);
    }

    function connect() {
        disconnect();
        var wsUri = (window.location.protocol == 'https:' && 'wss://' || 'ws://') + window.location.host + '/ws';
        conn = new WebSocket(wsUri);
        conn.onopen = function() {
            console.log('Connected.');
            update_ui();
            err_acc = 0;
        };
        conn.onmessage = function(e) {
            var data = JSON.parse(e.data);
            switch (data.action) {
                case 'connect':
                    var info = data.info;
                    update_status(info);
                    update_ui();
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
            console.log('Disconnected');
            conn = null;
            update_ui();
            console.log('Websocket closed because: ' + e.reason);
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
                window.location = '/login.html';
            }
        };
        conn.onerror = function(e) {
            console.log('Error: ' + JSON.stringify(e));
            err_acc ++;
            // conn.close();
            // conn = null;
            // update_ui();
        };

    }

    function disconnect() {
        if (conn != null) {
            //log('Disconnecting...');
            conn.close();
            conn = null;
            update_ui();
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

    function update_ui() {
        if (conn == null) {
            $('#status').text('disconnected');
            $('#send').prop("disabled", true);
        } else {
            $('#status').text('connected');
            $('#send').prop("disabled", false);
        }
    }

    // send when press enter
    // disable the submit button when the textarea is empty
    var textarea = $('textarea');
    var submit = $('input#send_message');
    textarea.keyup(function(e) {
        if($(this).val().length > 0) {
            submit.prop("disabled", false); 
        } else { 
            submit.prop("disabled", true);
        }
    });

    submit.on('click', function() {
        var text = textarea.val();
        if (text) {
            conn.send(JSON.stringify({
                action: 'send',
                data: text
            }));
            textarea.val('');
            // textarea.focus(); bad UE on mobile
            submit.prop("disabled", true);
        }
        return false;
    });
    
    connect(); // connect immediately
    // ======END======



    // =====BEGIN=====Upload files
    var file_input = $('form#file input');
    var percent = $('.percent');
    var options = {
        beforeSend: function() {
            percent.text('0%');
        },
        uploadProgress: function(event, position, total, percentComplete) {
            percent.text(percentComplete + '%');
        },
        complete: function(xhr, textStatus) {
            // success or error
            percent.text(xhr.responseText);
        }
    };
    // forward the click event
    $("input#upload_files").click(function () {
        file_input.trigger('click');
    });
    // listen on select file
    file_input.on('change', function(){
        if (this.value) {
            // submit when the field is not empty
            $("form#file").ajaxSubmit(options);
        }
    });
    // ======END======
});